# 500e SoC — PWA

Lit l'état de charge (SoC) de la batterie d'une Fiat 500e 2020+ via un dongle OBD BLE type ELM327 (Veepeak OBDCheck BLE+).

## Mise en ligne (HTTPS obligatoire pour Web Bluetooth)

Le plus simple : GitHub Pages.
1. Crée un dépôt, envoie les 5 fichiers (`index.html`, `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`).
2. Settings → Pages → Branch `main` / root → Save.
3. Ouvre `https://<toi>.github.io/<depot>/` dans **Chrome sur Android**, puis menu ⋮ → « Installer l'application ».

Alternative : Netlify Drop (glisser-déposer le dossier sur app.netlify.com/drop).

Test local sur ordinateur : `python3 -m http.server 8000` puis http://localhost:8000 (localhost est autorisé sans HTTPS).

## Utilisation
1. Branche le dongle (prise OBD sous le volant, côté gauche), mets le contact / mode READY.
2. **Ne pas** appairer le dongle dans les réglages Bluetooth du téléphone : la PWA s'y connecte directement.
3. « Connecter le dongle » → choisis l'appareil (souvent « VEEPEAK » ou « OBDBLE »).

## Compatibilité navigateur
- ✅ Chrome / Edge Android, Chrome / Edge ordinateur
- ❌ Safari iOS et Firefox (pas de Web Bluetooth) — sur iPhone, utiliser l'app « Bluefy »

## Détails techniques
- CAN 29 bits 500 kbit/s (`ATSP7`), BMS : requête `18DA44F1`, réponse `18DAF144`
- SoC : `22A010`, octet 5 ÷ 255 × 100 (SoC brut BMS : peut différer de 1–3 points de l'affichage du tableau de bord)
- Tension `22A011`, courant `22A00A`, température `22A009`, SoH `22A029` (formules communautaires, à vérifier)
