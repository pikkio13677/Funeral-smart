# Email e variabili del servizio — Resend

Il backend invia email transazionali tramite l'API HTTPS di Resend. Le chiavi e gli altri segreti restano esclusivamente nelle variabili d'ambiente del servizio backend: non inserirli in GitHub, nel frontend o in chat.

## Variabili dichiarate nel Blueprint Render

- `ADMIN_API_KEY`: chiave legacy di compatibilità, da mantenere solo secondo la procedura di transizione; non inserirla mai nel browser.
- `BOOTSTRAP_ADMIN_TOKEN`: token iniziale robusto per creare il primo amministratore. È un segreto e va configurato fuori dal repository. Dopo il bootstrap, ruotarlo o disattivarlo secondo la procedura approvata.
- `TOTP_ENCRYPTION_KEY`: chiave dedicata di 32 byte, rappresentata da 64 caratteri esadecimali, necessaria per cifrare i segreti Authenticator. Deve restare stabile: non ruotarla senza una procedura di migrazione e recupero.
- `CORS_ORIGIN`: soltanto le origini HTTPS effettive autorizzate, separate da virgole se sono più di una.
- `PUBLIC_APP_URL`: URL HTTPS pubblico usato per i link d'invito, senza percorsi aggiuntivi.
- `RESEND_API_KEY`: chiave API Resend con permesso Sending.
- `RESEND_FROM_EMAIL`: mittente autorizzato in Resend, appartenente a un dominio verificato per gli invii reali.
- `ENABLE_MULTI_TENANT`: il Blueprint imposta esplicitamente `false`. Non cambiarlo in `true` finché la catena di PR, le migrazioni su staging, il backup/restore e il collaudo end-to-end non sono stati approvati.

I valori segreti sono dichiarati come variabili da fornire manualmente a Render; il repository non contiene i loro valori.

## Dominio e invio reale

Per inviare inviti a colleghi e clienti, verifica in Resend un dominio che possiedi e completa i record DNS richiesti. Il mittente deve appartenere a quel dominio verificato.

Il mittente di prova `onboarding@resend.dev` è limitato ai test e non è adatto agli invii reali a terzi.

## Stato e attivazione

- L'adattatore Resend, la richiesta di verifica email e i flussi di invito sono coperti da test simulati.
- Le nuove route multi-azienda sono protette dal flag `ENABLE_MULTI_TENANT`, che resta disattivato.
- L'aggiunta delle variabili al Blueprint non configura da sola i segreti su Render, non invia email e non abilita la modalità multi-azienda.
- Prima di qualunque invio reale occorre verificare il dominio, configurare le variabili direttamente su Render e autorizzare una prova con destinatari di test.

## Test

Eseguire `npm test`. I test usano un client HTTP simulato e non inviano email reali.
