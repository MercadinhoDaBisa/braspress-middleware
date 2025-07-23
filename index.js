require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https'); // Necessário para ignorar erros SSL se a API Braspress precisar

const app = express();

app.use(express.raw({ type: 'application/json' }));
app.use(express.json());

// Agente HTTPS para lidar com certificados SSL (se necessário, alguns APIs legado exigem)
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
        let cubagemTotal = 0; // Braspress geralmente usa dimensões (altura, largura, comprimento)
        let qtdeVolumeTotal = 0;

        if (yampiData.skus && Array.isArray(yampiData.skus)) {
            yampiData.skus.forEach(sku => {
                const pesoItem = sku.weight || 0;
                const quantidadeItem = sku.quantity || 1;
                const comprimento = sku.length || 0;
                const largura = sku.width || 0;
                const altura = sku.height || 0;

                pesoTotal += pesoItem * quantidadeItem;
                // Braspress pode pedir as dimensões individuais ou total da embalagem
                // Por agora, vou usar cubagem para referência, mas a API pode exigir formatação específica
                cubagemTotal += (comprimento * largura * altura / 1000000) * quantidadeItem;
                qtdeVolumeTotal += quantidadeItem;
            });
        }

        const opcoesFrete = [];

        // --- Cotação Braspress ---
        try {
            // A API da Braspress é SOAP e pode ser complexa.
            // O ideal é consultar a documentação completa da Braspress sobre a estrutura do XML/JSON esperado.
            // Este é um PLACEHOLDER para o payload, você precisará ajustá-lo.
            const payloadBraspress = {
                // EX: "token": "...", "cnpj": "...", "cepOrigem": "...", "cepDestino": "...", "peso": "...", "valorNF": "...", "volumes": [...]
                // É CRÍTICO consultar a DOCUMENTAÇÃO DA BRASPRESS para montar este payload corretamente.
                // A maioria das APIs SOAP exige um XML formatado, não um JSON simples.
                // Se for XML, você precisará de uma biblioteca para construir o XML.
                // Vamos supor que seja JSON por enquanto para manter a estrutura do axios.
                "cnpj": BRASPRESS_CNPJ,
                "usuario": BRASPRESS_USER,
                "senha": BRASPRESS_PASSWORD,
                "cepOrigem": cepOrigem,
                "cepDestino": cepDestino,
                "peso": pesoTotal,
                "valorDeclarado": valorDeclarado,
                "volumes": qtdeVolumeTotal, // Ou um array detalhado de volumes com dimensões
                "tipoServico": "NORMAL", // Exemplo, pode ser um código Braspress
                // Outros campos da Braspress que a API deles pode exigir:
                // "dimensoes": { "altura": ..., "largura": ..., "comprimento": ... },
                // "tipoCarga": "..."
            };

            console.log('Payload Braspress Enviado:', JSON.stringify(payloadBraspress, null, 2));

            // URL da API Braspress (Pode ser necessário especificar um endpoint mais detalhado para cotação)
            const braspressApiUrl = 'https://api.braspress.com/'; // Verifique a documentação para o endpoint de cotação

            const responseBraspress = await axios.post(
                braspressApiUrl,
                payloadBraspress,
                {
                    // Cabeçalhos podem ser necessários para autenticação e tipo de conteúdo
                    headers: {
                        'Content-Type': 'application/json', // Ou 'application/xml' se for SOAP XML
                        // Possíveis headers de autenticação como 'Authorization', 'x-api-key', etc.
                    },
                    httpsAgent: agent // Se necessário para lidar com certificados
                }
            );

            // Processar a resposta da Braspress
            if (responseBraspress.data) {
                // A estrutura da resposta da Braspress é desconhecida neste momento.
                // Você precisará inspecionar responseBraspress.data e extrair o preço, prazo, etc.
                // Exemplo hipotético:
                if (responseBraspress.data.frete && responseBraspress.data.frete.valor) {
                    opcoesFrete.push({
                        "name": "Braspress Padrão",
                        "service": "Braspress",
                        "price": responseBraspress.data.frete.valor,
                        "days": responseBraspress.data.frete.prazo || 0,
                        "quote_id": "braspress_standard"
                    });
                } else {
                    console.warn('Resposta da Braspress não contém dados de frete esperados:', responseBraspress.data);
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