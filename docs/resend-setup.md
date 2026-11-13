# Email inviti — Resend

Il modulo `resend-email.js` invia email transazionali dal backend tramite l'API HTTPS di Resend. Non richiede l'SDK e non espone mai la chiave al browser.

## Variabili Render

Configurare esclusivamente nel servizio backend:

- `RESEND_API_KEY`: chiave API Resend con permesso Sending.
- `RESEND_FROM_EMAIL`: mittente autorizzato. Per il solo test iniziale può essere `FUNERAL SMART <onboarding@resend.dev>`; in produzione usare un indirizzo appartenente a un dominio verificato in Resend.

Non inserire mai la chiave in GitHub, nel frontend o in chat.

## Limite del mittente di prova

Il mittente `onboarding@resend.dev` è destinato ai test e può inviare soltanto all'indirizzo email proprietario dell'account Resend. Non consente di invitare colleghi o clienti. Per invii reali a terzi occorre verificare in Resend un dominio che si possiede e usare un mittente di quel dominio.

## Stato dell'integrazione

Questo modulo è un adattatore server-side pronto per essere iniettato in `tenant-invitation-routes.js`. La route multi-azienda e le relative migrazioni sono ancora in una pull request separata e in stato draft; il backend di produzione non viene modificato da questa PR. Prima dell'attivazione completa occorre integrare e testare il contesto aziendale, le migrazioni e l'endpoint di accettazione inviti su un database di prova.

## Test

Eseguire `npm test`. I test usano un client HTTP simulato e non inviano email reali.
