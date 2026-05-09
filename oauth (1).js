// ============================================================
//  oauth.js — Génère ton Refresh Token Google
//  Lance avec : node oauth.js
//  Puis copie le refresh_token dans ton .env
// ============================================================

const { google } = require('googleapis');
const readline = require('readline');
require('dotenv').config();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:8080/callback' // Mode "copier-coller" — pas besoin d'URL de redirection
);

// Scopes nécessaires pour Google Ads
const SCOPES = ['https://www.googleapis.com/auth/adwords'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // Force l'affichage du refresh token
});

console.log('\n========================================');
console.log('  AdsFlow AI — Génération Refresh Token');
console.log('========================================\n');
console.log('1. Ouvre ce lien dans ton navigateur :');
console.log('\n' + authUrl + '\n');
console.log('2. Connecte-toi avec ton compte Google Ads');
console.log('3. Autorise l\'accès');
console.log('4. Copie le code affiché et colle-le ici\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Colle le code ici : ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log('\n========================================');
    console.log('  ✓ Refresh Token généré avec succès !');
    console.log('========================================\n');
    console.log('Copie cette ligne dans ton fichier .env :\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log('⚠  Garde ce token secret — ne le partage jamais !');
  } catch (err) {
    console.error('\n✗ Erreur :', err.message);
    console.error('Vérifie que ton Client ID et Client Secret sont corrects dans .env');
  }
});
