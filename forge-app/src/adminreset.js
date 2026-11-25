import { pool } from './db.js';
import { resetAdmin } from './users.js';

const admin = await resetAdmin();
await pool.end();
console.log(`Compte ${admin.username} réinitialisé : actif, TOTP retiré, nouveau mot de passe à changer à la première connexion.`);
console.log('Mot de passe : docker exec -it forge-app adminpasswd');
