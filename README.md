# EV Batterie — PWA OBD universelle

Lit le SoC et les données batterie d'une voiture électrique via un dongle OBD BLE type ELM327
(testé : Veepeak OBDCheck BLE+ sur Fiat 500e 2021).

## Fichiers
index.html · app.js (interface) · elm.js (BLE + décodage ELM327) · formula.js (formules ABRP, sans eval)
profiles.json (20 profils) · sw.js · manifest.webmanifest · icônes · licenses/

## Mise en ligne
HTTPS obligatoire (GitHub Pages, Netlify…). Ouvrir dans Chrome Android → ⋮ → Installer l'application.
Test local : `python3 -m http.server 8000` → http://localhost:8000

## Profils
Format ABRP (https://github.com/iternio/ev-obd-pids). Lettres : A = 1er octet après l'écho (ex. après 62 A0 10).
Clés reconnues : soc, voltage, current, power, batt_temp, ext_temp, soh, soe, capacity, kwh_charged,
odometer, speed, vehicle_reported_speed, is_charging, is_dcfc, is_parked. Les clés commençant par « _ »
sont affichées telles quelles ; _cell_min_voltage / _cell_max_voltage donnent la tuile « cellules ».
Ajouter un véhicule : bouton « Importer un profil JSON », ou ajouter une entrée dans profiles.json.

Les profils autres que la Fiat 500e proviennent du dépôt communautaire d'ABRP, qui les dit lui-même
partiellement obsolètes : à valider avec le mode découverte.

## Licences
Profils iternio/ev-obd-pids : Apache 2.0 (voir licenses/). Profil Fiat 500e : relevés communautaires.

## Compatibilité
Chrome/Edge Android et ordinateur. iPhone : navigateur Bluefy. Pas de Safari ni Firefox (pas de Web Bluetooth).
