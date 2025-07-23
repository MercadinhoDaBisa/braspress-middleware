require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https'); // Necessário para ignorar erros SSL se a API Braspress precisar

const app = express(); // Linha temporaria para forcar o Git a reconhecer a mudanca

app.use(express.raw({ type: 'application/json' }));
app.use(express.json());

// Agente HTTPS para lidar com certificados SSL (se necessário, alguns APIs legado exigem)
// Use com cautela em produção, ideal é que o certificado seja válido.
const agent = new https.Agent({
    rejectUnauthorized: false
});

// --- Variáveis de Ambiente ---
const YAMPI_SECRET_TOKEN = process.env.YAMPI_SECRET_TOKEN;
const BRASPRESS_CNPJ = process.env.BRASPRESS_CNPJ;
const BRASPRESS_USER = process.env.BRASPRESS_USER;
const BRASPRESS_PASSWORD = process.env.BRASPRESS_PASSWORD;

app.post('/cotacao', async (req, res) => {
    console.log('Headers Recebidos:', req.headers);

    const yampiSignature = req.headers['x-yampi-hmac-sha256'];
    const requestBodyRaw = req.body;

    // --- Validação de Segurança Yampi ---
    if (!yampiSignature || !YAMPI_SECRET_TOKEN) {
        console.error('Erro de Segurança: Assinatura Yampi ou Chave Secreta ausente.');
        return res.status(401).json({ error: 'Acesso não autorizado.' });
    }

    let calculatedSignature;
    try {
        const hmac = crypto.createHmac('sha256', YAMPI_SECRET_TOKEN);
        const parsedBody = JSON.parse(requestBodyRaw.toString('utf8'));
        const normalizedBodyString = JSON.stringify(parsedBody);
        hmac.update(normalizedBodyString);
        calculatedSignature = hmac.digest('base64');
    } catch (error) {
        console.error('Erro ao calcular a assinatura HMAC:', error.message);
        return res.status(500).json({ error: 'Erro interno na validação de segurança.' });
    }

    if (calculatedSignature !== yampiSignature) {
        console.error('Erro de Segurança: Assinatura Yampi inválida. Calculada:', calculatedSignature, 'Recebida:', yampiSignature);
        return res.status(401).json({ error: 'Acesso não autorizado. Assinatura Yampi inválida.' });
    }

    console.log('Validação de segurança Yampi: SUCESSO!');

    try {
        const yampiData = JSON.parse(requestBodyRaw.toString('utf8'));
        console.log('Payload Yampi Recebido:', JSON.stringify(yampiData, null, 2));

        // --- Dados necessários da Yampi ---
        const cepOrigem = "30720404"; // CEP de origem fixo, se for sempre o mesmo
        const cepDestino = yampiData.zipcode ? yampiData.zipcode.replace(/\D/g, '') : null;
        const valorDeclarado = yampiData.amount || 0;
        const cnpjCpfDestinatario = yampiData.cart && yampiData.cart.customer ? yampiData.cart.customer.document : null;

        let pesoTotal = 0;
        let cubagemTotal = 0; 
        let qtdeVolumeTotal = 0;

        if (yampiData.skus && Array.isArray(yampiData.skus)) {
            yampiData.skus.forEach(sku => {
                const pesoItem = sku.weight || 0;
                const quantidadeItem = sku.quantity || 1;
                const comprimento = sku.length || 0;
                const largura = sku.width || 0;
                const altura = sku.height || 0;

                pesoTotal += pesoItem * quantidadeItem;
                cubagemTotal += (comprimento * largura * altura / 1000000) * quantidadeItem;
                qtdeVolumeTotal += quantidadeItem;
            });
        }

        const opcoesFrete = [];

        // --- Cotação Braspress ---
        try {
            // Este payload é uma suposição e precisará ser ajustado conforme a documentação EXATA da Braspress.
            // A API da Braspress geralmente usa uma estrutura XML complexa ou JSON com formatos específicos.
            const payloadBraspress = {
                "cnpjRemetente": BRASPRESS_CNPJ,
                "usuario": BRASPRESS_USER,
                "senha": BRASPRESS_PASSWORD,
                "origem": cepOrigem,
                "destino": cepDestino,
                "peso": pesoTotal,
                "valorNf": valorDeclarado, // Nome do campo pode variar (ex: valorDeclarado)
                "tipoServico": "NORMAL", // Exemplo, pode ser um código Braspress (ex: '0' ou '1')
                "tipoEntrega": "D", // Exemplo, "D" para delivery
                "volumes": [ // A Braspress pode exigir um array detalhado de volumes
                    {
                        "cubagem": cubagemTotal, // Cubagem total dos itens em m³
                        "peso": pesoTotal,
                        "quantidade": qtdeVolumeTotal,
                        // Se a Braspress exigir dimensões por volume, você precisará iterar os SKUs
                        // "altura": yampiData.skus[0].height,
                        // "largura": yampiData.skus[0].width,
                        // "comprimento": yampiData.skus[0].length,
                    }
                ]
                // Outros campos que a documentação da Braspress pode exigir:
                // "isencaoInscricaoEstadual": false,
                // "naturezaCarga": "OUTROS",
            };

            console.log('Payload Braspress Enviado:', JSON.stringify(payloadBraspress, null, 2));

            // <<<<<<< ATENÇÃO AQUI! URL CORRIGIDA PARA O ENDPOINT DA BRASPRESS
            const braspressApiUrl = `https://api.braspress.com/v1/cotacao/calcular/json`; // Retorno esperado JSON

            const responseBraspress = await axios.post(
                braspressApiUrl,
                payloadBraspress,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        // Adicionar cabeçalhos de autenticação se a API da Braspress exigir (ex: 'Authorization')
                    },
                    httpsAgent: agent // Se necessário para ignorar certificados SSL inválidos
                }
            );

            // Processar a resposta da Braspress
            if (responseBraspress.data) {
                // A estrutura EXATA da resposta da Braspress precisa ser confirmada pela documentação.
                // Este é um exemplo hipotético baseado em respostas comuns.
                if (responseBraspress.data.cotacao && responseBraspress.data.cotacao.valorTotalFrete) {
                    opcoesFrete.push({
                        "name": "Braspress",
                        "service": "Braspress_Standard",
                        "price": responseBraspress.data.cotacao.valorTotalFrete,
                        "days": responseBraspress.data.cotacao.prazoEntrega || 0,
                        "quote_id": "braspress_cotacao"
                    });
                } else if (responseBraspress.data.error) {
                    console.error('Erro retornado pela API da Braspress:', responseBraspress.data.error);
                } else {
                    console.warn('Resposta da Braspress não contém dados de frete esperados:', JSON.stringify(responseBraspress.data, null, 2));
                }
            }

        } catch (error) {
            console.error('Erro na requisição Braspress ou processamento:', error.message);
            if (error.response && error.response.data) {
                console.error('Detalhes do erro da Braspress:', error.response.data);
            }
        }

        const respostaFinalYampi = {
            "quotes": opcoesFrete
        };

        console.log('Resposta FINAL enviada para Yampi:', JSON.stringify(respostaFinalYampi, null, 2));
        res.json(respostaFinalYampi);

    } catch (erro) {
        console.error('Erro geral no processamento do webhook:', erro.message);
        return res.status(500).json({ erro: 'Erro interno no servidor de cotação.' });
    }
});

app.get('/', (req, res) => {
    res.send('Middleware da Braspress rodando');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));