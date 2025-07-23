require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https'); 

const app = express();

app.use(express.raw({ type: 'application/json' }));
app.use(express.json());

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

        const cepOrigem = "30720404"; // CEP de origem fixo
        const cepDestino = yampiData.zipcode ? yampiData.zipcode.replace(/\D/g, '') : null;
        // O campo 'document' da Yampi pode ser CPF ou CNPJ. A Braspress pede 'cnpjDestinatario'.
        // Se precisar diferenciar ou ter o CNPJ do cliente, será necessário mais lógica aqui.
        // Por enquanto, vamos usar um CNPJ fictício ou deixar em branco se não for essencial.
        const cnpjDestinatario = yampiData.cart && yampiData.cart.customer && yampiData.cart.customer.document ? yampiData.cart.customer.document.replace(/\D/g, '') : null;

        let pesoTotal = 0;
        let cubagensItems = []; // Array para armazenar os detalhes de cubagem por item/volume
        let qtdeVolumeTotal = 0; // Quantidade total de volumes simples

        if (yampiData.skus && Array.isArray(yampiData.skus)) {
            yampiData.skus.forEach(sku => {
                const pesoItem = sku.weight || 0;
                const quantidadeItem = sku.quantity || 1;
                const comprimento = sku.length || 0;
                const largura = sku.width || 0;
                const altura = sku.height || 0;

                pesoTotal += pesoItem * quantidadeItem;
                qtdeVolumeTotal += quantidadeItem; // Cada SKU é considerado um volume simples
                
                // Adiciona os detalhes de cubagem para cada item/volume conforme o exemplo da Braspress
                cubagensItems.push({
                    "altura": altura / 100, // Converter cm para metros
                    "largura": largura / 100, // Converter cm para metros
                    "comprimento": comprimento / 100, // Converter cm para metros
                    "volumes": quantidadeItem // A quantidade de volumes com essas dimensões
                });
            });
        }

        const opcoesFrete = [];

        // --- Cotação Braspress ---
        try {
            const authString = `${BRASPRESS_USER}:${BRASPRESS_PASSWORD}`;
            const encodedAuth = Buffer.from(authString).toString('base64');
            
            // <<<<<<< ATENÇÃO AQUI! AJUSTES FINAIS DE PAYLOAD (Conforme Documentação)
            const payloadBraspress = {
                "cnpjRemetente": BRASPRESS_CNPJ,
                "cnpjDestinatario": cnpjDestinatario || "99999999999999", // CNPJ do destinatário, ou um default se não for essencial para o cálculo
                "modal": "R", // Rodoviário, conforme exemplo
                "tipoFrete": "1", // Tipo de frete (ex: 1 = CIF, 2 = FOB - confirmar com Braspress)
                "cepOrigem": cepOrigem,
                "cepDestino": cepDestino,
                "vlrMercadoria": yampiData.amount || 0, // Valor da mercadoria (antes era valorNf)
                "peso": pesoTotal,
                "volumes": qtdeVolumeTotal, // Quantidade total de volumes (número inteiro)
                "cubagem": cubagensItems // Array de objetos de cubagem
            };
            // <<<<<<< FIM AJUSTES FINAIS DE PAYLOAD

            console.log('Payload Braspress Enviado:', JSON.stringify(payloadBraspress, null, 2));

            const braspressApiUrl = `https://api.braspress.com/v1/cotacao/calcular/json`; 

            const responseBraspress = await axios.post(
                braspressApiUrl,
                payloadBraspress,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Basic ${encodedAuth}`
                    },
                    httpsAgent: agent 
                }
            );

            if (responseBraspress.data) {
                // A estrutura da resposta pode ser diferente do que o exemplo curl/js mostra no console.log
                // Verifique o formato real da resposta para extrair os dados.
                // Exemplo hipotético de estrutura de resposta:
                if (responseBraspress.data.cotacao && responseBraspress.data.cotacao.valorTotalFrete) {
                    opcoesFrete.push({
                        "name": "Braspress",
                        "service": "Braspress_Standard",
                        "price": responseBraspress.data.cotacao.valorTotalFrete,
                        "days": responseBraspress.data.cotacao.prazoEntrega || 0,
                        "quote_id": "braspress_cotacao"
                    });
                } else if (responseBraspress.data.erro) { // Alguns APIs usam 'erro' ao invés de 'error'
                    console.error('Erro retornado pela API da Braspress:', responseBraspress.data.erro.mensagem || JSON.stringify(responseBraspress.data.erro, null, 2));
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