// ============================================================
//  AdsFlow AI — Backend Google Ads
//  Sert d'intermédiaire entre ton app HTML et l'API Google Ads
// ============================================================

const express = require('express');
const cors = require('cors');
const { GoogleAdsApi } = require('google-ads-api');
require('dotenv').config();

const app = express();
app.use(cors()); // Autorise ton app HTML à appeler ce serveur
app.use(express.json());

// -------------------------------------------------------
// Initialisation du client Google Ads
// -------------------------------------------------------
const client = new GoogleAdsApi({
  client_id:     process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_DEVELOPER_TOKEN,
});

// -------------------------------------------------------
// ROUTE TEST — vérifie que le serveur tourne
// -------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'AdsFlow Backend opérationnel ✓' });
});

// -------------------------------------------------------
// ROUTE : Lister les comptes Google Ads liés
// -------------------------------------------------------
app.get('/accounts', async (req, res) => {
  try {
    const customer = client.Customer({
      customer_id: process.env.GOOGLE_CUSTOMER_ID,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const accounts = await customer.query(`
      SELECT
        customer_client.id,
        customer_client.descriptive_name,
        customer_client.currency_code,
        customer_client.time_zone
      FROM customer_client
      WHERE customer_client.level <= 1
    `);

    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// ROUTE : Créer une campagne complète (Search Local)
// -------------------------------------------------------
app.post('/create-campaign', async (req, res) => {
  const {
    campaignName,
    budgetPerDay,     // en euros (ex: 10 = 10€/jour)
    locationIds,      // ex: [9040769] = Sarrebourg, [9040690] = Metz
    radius,           // rayon en km
    lat, lng,         // coordonnées GPS du centre
    headlines,        // tableau de titres générés par l'IA
    descriptions,     // tableau de descriptions
    finalUrl,         // URL de destination (ex: https://vdkustom.fr)
    phoneNumber,      // ex: +33312345678
    keywords,         // tableau de mots-clés
    negativeKeywords, // mots-clés négatifs
  } = req.body;

  try {
    const customer = client.Customer({
      customer_id: process.env.GOOGLE_CUSTOMER_ID,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    // --- 1. Créer le budget ---
    const [budgetResource] = await customer.campaignBudgets.create([{
      name: `Budget ${campaignName} - ${Date.now()}`,
      amount_micros: budgetPerDay * 1_000_000, // Google Ads utilise les micro-unités
      delivery_method: 'STANDARD',
    }]);

    // --- 2. Créer la campagne ---
    const [campaignResource] = await customer.campaigns.create([{
      name: campaignName,
      status: 'PAUSED', // On crée en pause — tu actives toi-même dans Google Ads
      advertising_channel_type: 'SEARCH',
      campaign_budget: budgetResource,
      network_settings: {
        target_google_search: true,
        target_search_network: true,
        target_content_network: false,
      },
      // Stratégie d'enchères : maximiser les conversions (appels)
      maximize_conversions: {},
      // Ciblage local par rayon
      geo_target_type_setting: {
        positive_geo_target_type: 'PRESENCE_OR_INTEREST',
      },
    }]);

    // --- 3. Ajouter le ciblage géographique par rayon ---
    await customer.campaignCriteria.create([{
      campaign: campaignResource,
      // Ciblage par rayon autour d'un point GPS
      proximity: {
        address: { latitude_in_micro_degrees: Math.round(lat * 1_000_000), longitude_in_micro_degrees: Math.round(lng * 1_000_000) },
        radius: radius,
        radius_units: 'KILOMETERS',
      },
      negative: false,
    }]);

    // --- 4. Créer le groupe d'annonces ---
    const [adGroupResource] = await customer.adGroups.create([{
      name: `${campaignName} — Groupe principal`,
      campaign: campaignResource,
      status: 'ENABLED',
      type: 'SEARCH_STANDARD',
      cpc_bid_micros: 500_000, // Enchère CPC de départ : 0.50€
    }]);

    // --- 5. Ajouter les mots-clés ---
    const kwsToCreate = keywords.map(kw => ({
      ad_group: adGroupResource,
      keyword: {
        text: kw,
        match_type: 'PHRASE', // Correspondance expression (recommandé pour le local)
      },
      status: 'ENABLED',
    }));
    await customer.adGroupCriteria.create(kwsToCreate);

    // --- 6. Ajouter les mots-clés négatifs ---
    if (negativeKeywords && negativeKeywords.length > 0) {
      const negKws = negativeKeywords.map(kw => ({
        campaign: campaignResource,
        keyword: { text: kw, match_type: 'BROAD' },
        negative: true,
      }));
      await customer.campaignCriteria.create(negKws);
    }

    // --- 7. Créer l'annonce responsive (RSA) ---
    await customer.adGroupAds.create([{
      ad_group: adGroupResource,
      status: 'ENABLED',
      ad: {
        responsive_search_ad: {
          headlines: headlines.slice(0, 15).map((text, i) => ({
            text,
            // Épingler le premier titre en position 1
            pinned_field: i === 0 ? 'HEADLINE_1' : undefined,
          })),
          descriptions: descriptions.slice(0, 4).map(text => ({ text })),
        },
        final_urls: [finalUrl],
      },
    }]);

    // --- 8. Ajouter l'extension d'appel ---
    if (phoneNumber) {
      await customer.customerExtensionSettings.create([{
        extensions: [{
          call_feed_item: {
            phone_number: phoneNumber,
            country_code: 'FR',
            call_tracking_enabled: true,
          },
        }],
      }]);
    }

    res.json({
      success: true,
      message: 'Campagne créée avec succès (en pause) ✓',
      campaignId: campaignResource,
      adGroupId: adGroupResource,
    });

  } catch (err) {
    console.error('Erreur création campagne:', err);
    res.status(500).json({ success: false, error: err.message, details: err });
  }
});

// -------------------------------------------------------
// ROUTE : Récupérer les stats d'une campagne
// -------------------------------------------------------
app.get('/stats/:customerId', async (req, res) => {
  try {
    const customer = client.Customer({
      customer_id: req.params.customerId,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const stats = await customer.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.impressions,
        metrics.clicks,
        metrics.ctr,
        metrics.average_cpc,
        metrics.cost_micros,
        metrics.phone_calls,
        metrics.conversions
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
    `);

    const formatted = stats.map(row => ({
      id: row.campaign.id,
      name: row.campaign.name,
      status: row.campaign.status,
      impressions: row.metrics.impressions,
      clicks: row.metrics.clicks,
      ctr: (row.metrics.ctr * 100).toFixed(2) + '%',
      avgCpc: (row.metrics.average_cpc / 1_000_000).toFixed(2) + '€',
      cost: (row.metrics.cost_micros / 1_000_000).toFixed(2) + '€',
      calls: row.metrics.phone_calls,
      conversions: row.metrics.conversions,
    }));

    res.json({ success: true, stats: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// ROUTE : Activer / Pauser une campagne
// -------------------------------------------------------
app.post('/toggle-campaign', async (req, res) => {
  const { campaignId, action } = req.body; // action: 'ENABLED' ou 'PAUSED'
  try {
    const customer = client.Customer({
      customer_id: process.env.GOOGLE_CUSTOMER_ID,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    await customer.campaigns.update([{
      resource_name: campaignId,
      status: action,
    }]);

    res.json({ success: true, message: `Campagne ${action === 'ENABLED' ? 'activée' : 'pausée'} ✓` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// DÉMARRAGE DU SERVEUR
// -------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ AdsFlow Backend démarré sur le port ${PORT}`);
  console.log(`✓ Test santé : http://localhost:${PORT}/health`);
});
