// ============================================================
//  AdsFlow AI — Backend Google Ads (REST uniquement, sans gRPC)
//  Compatible Railway / Render / Vercel
// ============================================================

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// -------------------------------------------------------
// UTILITAIRE : Obtenir un Access Token depuis le Refresh Token
// -------------------------------------------------------
async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Impossible obtenir access token: ' + JSON.stringify(data));
  return data.access_token;
}

// -------------------------------------------------------
// UTILITAIRE : Appel API Google Ads REST
// -------------------------------------------------------
async function googleAdsRequest(endpoint, method = 'GET', body = null) {
  const token = await getAccessToken();
  const customerId = process.env.GOOGLE_CUSTOMER_ID;
  const baseUrl = `https://googleads.googleapis.com/v16/customers/${customerId}`;

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      'Authorization':     `Bearer ${token}`,
      'developer-token':   process.env.GOOGLE_DEVELOPER_TOKEN,
      'Content-Type':      'application/json',
      'login-customer-id': customerId,
    },
    body: body ? JSON.stringify(body) : null,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data?.error || data));
  return data;
}

// -------------------------------------------------------
// ROUTE : Servir l'app HTML
// -------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/adsflow_v4.html');
});

// -------------------------------------------------------
// ROUTE TEST
// -------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'AdsFlow Backend operationnel (REST)' });
});

// -------------------------------------------------------
// ROUTE : Generation IA via Groq (proxy)
// -------------------------------------------------------
app.post('/generate-ad', async (req, res) => {
  const { service, zone, usp, tone, keywords } = req.body;

  const zoneLabels = {
    metz:        'Metz et alentours — Moselle 57, Woippy, Montigny-les-Metz, Noisseville',
    gorze:       'Gorze et alentours — Vionville, Rezonville, Gravelotte, Ars-sur-Moselle',
    noisseville: 'Noisseville et alentours — Chesny, Saint-Julien-les-Metz, est de Metz',
    all:         'Metz, Gorze et Noisseville — zone Moselle Grand Est',
  };
  const toneMap = {
    premium:   'luxueux et haut de gamme, clientele prestige',
    confiance: 'expert local reconnu et rassurant',
    urgence:   'direct et percutant, appel a action fort',
    promo:     'promotionnel avec offre attractive',
  };

  const prompt = `Tu es expert Google Ads specialise en campagnes locales pour artisans.

Genere des annonces Google Ads LOCALES pour declencher des appels telephoniques qualifies.

Prestataire: VDKustom (detailing automobile haut de gamme)
Service: ${service}
Zone: ${zoneLabels[zone] || zone}
USP: ${usp}
Ton: ${toneMap[tone] || tone}
Mots-cles: ${keywords}

REGLES: titres DOIVENT mentionner la ville (Metz, Gorze, Noisseville, Moselle). Objectif = appel telephone.

Reponds UNIQUEMENT en JSON valide sans markdown:
{"headlines":["t1 max30c","t2 max30c","t3 max30c","t4 max30c","t5 max30c"],"descriptions":["d1 max90c","d2 max90c"],"callExtension":"max25c","negativeKeywords":["kw1","kw2","kw3","kw4","kw5"],"bidStrategy":"strategie","localTip":"conseil zone","estimatedCTR":"x.x%","estimatedCPA":"euros X a Y par appel"}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model:      'llama-3.3-70b-versatile',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) throw new Error(`Groq erreur ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ success: true, ad: result });
  } catch (err) {
    console.error('Erreur generation IA:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// ROUTE : Creer une campagne Google Ads (REST pur)
// -------------------------------------------------------
app.post('/create-campaign', async (req, res) => {
  const {
    campaignName, budgetPerDay, radius, lat, lng,
    headlines, descriptions, finalUrl, phoneNumber,
    keywords, negativeKeywords,
  } = req.body;

  try {
    // 1. Budget
    const budgetRes = await googleAdsRequest('/campaignBudgets:mutate', 'POST', {
      operations: [{
        create: {
          name:           `Budget ${campaignName} ${Date.now()}`,
          amountMicros:   String(budgetPerDay * 1000000),
          deliveryMethod: 'STANDARD',
        },
      }],
    });
    const budgetResource = budgetRes.results[0].resourceName;
    console.log('Budget cree:', budgetResource);

    // 2. Campagne
    const campRes = await googleAdsRequest('/campaigns:mutate', 'POST', {
      operations: [{
        create: {
          name:                   campaignName,
          status:                 'PAUSED',
          advertisingChannelType: 'SEARCH',
          campaignBudget:         budgetResource,
          networkSettings: {
            targetGoogleSearch:   true,
            targetSearchNetwork:  true,
            targetContentNetwork: false,
          },
          maximizeConversions: {},
          geoTargetTypeSetting: {
            positiveGeoTargetType: 'PRESENCE_OR_INTEREST',
          },
        },
      }],
    });
    const campaignResource = campRes.results[0].resourceName;
    console.log('Campagne creee:', campaignResource);

    // 3. Ciblage geo par rayon
    await googleAdsRequest('/campaignCriteria:mutate', 'POST', {
      operations: [{
        create: {
          campaign: campaignResource,
          proximity: {
            address: {
              latitudeInMicroDegrees:  Math.round(lat * 1000000),
              longitudeInMicroDegrees: Math.round(lng * 1000000),
            },
            radius:      radius,
            radiusUnits: 'KILOMETERS',
          },
          negative: false,
        },
      }],
    });

    // 4. Groupe d'annonces
    const adGroupRes = await googleAdsRequest('/adGroups:mutate', 'POST', {
      operations: [{
        create: {
          name:         `${campaignName} - Groupe principal`,
          campaign:     campaignResource,
          status:       'ENABLED',
          type:         'SEARCH_STANDARD',
          cpcBidMicros: String(500000),
        },
      }],
    });
    const adGroupResource = adGroupRes.results[0].resourceName;

    // 5. Mots-cles
    if (keywords && keywords.length > 0) {
      await googleAdsRequest('/adGroupCriteria:mutate', 'POST', {
        operations: keywords.map(kw => ({
          create: {
            adGroup: adGroupResource,
            keyword: { text: kw, matchType: 'PHRASE' },
            status:  'ENABLED',
          },
        })),
      });
    }

    // 6. Mots-cles negatifs
    if (negativeKeywords && negativeKeywords.length > 0) {
      await googleAdsRequest('/campaignCriteria:mutate', 'POST', {
        operations: negativeKeywords.map(kw => ({
          create: {
            campaign: campaignResource,
            keyword:  { text: kw, matchType: 'BROAD' },
            negative: true,
          },
        })),
      });
    }

    // 7. Annonce RSA
    await googleAdsRequest('/adGroupAds:mutate', 'POST', {
      operations: [{
        create: {
          adGroup: adGroupResource,
          status:  'ENABLED',
          ad: {
            responsiveSearchAd: {
              headlines:    headlines.slice(0, 15).map(text => ({ text })),
              descriptions: descriptions.slice(0, 4).map(text => ({ text })),
            },
            finalUrls: [finalUrl],
          },
        },
      }],
    });

    console.log('Campagne complete creee avec succes');
    res.json({
      success:  true,
      message:  'Campagne creee avec succes (en pause)',
      campaign: campaignResource,
      adGroup:  adGroupResource,
    });

  } catch (err) {
    console.error('Erreur creation campagne:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// ROUTE : Stats
// -------------------------------------------------------
app.get('/stats/:customerId', async (req, res) => {
  try {
    const token = await getAccessToken();
    const customerId = process.env.GOOGLE_CUSTOMER_ID;

    const response = await fetch(
      `https://googleads.googleapis.com/v16/customers/${customerId}/googleAds:search`,
      {
        method: 'POST',
        headers: {
          'Authorization':     `Bearer ${token}`,
          'developer-token':   process.env.GOOGLE_DEVELOPER_TOKEN,
          'Content-Type':      'application/json',
          'login-customer-id': customerId,
        },
        body: JSON.stringify({
          query: `
            SELECT campaign.id, campaign.name, campaign.status,
              metrics.impressions, metrics.clicks, metrics.ctr,
              metrics.average_cpc, metrics.cost_micros,
              metrics.phone_calls, metrics.conversions
            FROM campaign
            WHERE segments.date DURING LAST_30_DAYS
              AND campaign.status != 'REMOVED'
            ORDER BY metrics.cost_micros DESC
          `,
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data?.error));

    const stats = (data.results || []).map(row => ({
      id:          row.campaign.id,
      name:        row.campaign.name,
      status:      row.campaign.status,
      impressions: row.metrics.impressions || 0,
      clicks:      row.metrics.clicks || 0,
      ctr:         (((row.metrics.ctr || 0) * 100).toFixed(2)) + '%',
      avgCpc:      (((row.metrics.averageCpc || 0) / 1000000).toFixed(2)) + 'euros',
      cost:        (((row.metrics.costMicros || 0) / 1000000).toFixed(2)) + 'euros',
      calls:       row.metrics.phoneCalls || 0,
      conversions: row.metrics.conversions || 0,
    }));

    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// ROUTE : Toggle campagne
// -------------------------------------------------------
app.post('/toggle-campaign', async (req, res) => {
  const { campaignId, action } = req.body;
  try {
    await googleAdsRequest('/campaigns:mutate', 'POST', {
      operations: [{
        update:     { resourceName: campaignId, status: action },
        updateMask: 'status',
      }],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// DEMARRAGE
// -------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AdsFlow Backend demarre sur le port ${PORT}`);
  console.log(`Mode REST pur - sans gRPC - compatible Railway`);
});
