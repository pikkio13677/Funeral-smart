# Email inviti — Resend

Il modulo `resend-email.js` invia email transazionali dal backend tramite l'API HTTPS di Resend. Non richiede l'SDK e non espone mai la chiave al browser.

## Variabili Render

Configurare esclusivamente nel servizio backend:

- `RESEND_API_KEY`: chiave API Resend con permesso Sending.
- `RESEND_FROM_EMAIL`: mittente autorizzato.
- `EMAIL_VERIFICATION_PEPPER`: segreto casuale dedicato di almeno 32 byte, usato come chiave HMAC per memorizzare i codici di verifica email. Generarlo con un password manager o un generatore crittografico e conservarlo solo nelle variabili d'ambiente Render. Non riutilizzare `RESEND_API_KEY` o `TOTP_ENCRYPTION_KEY`. Per il solo test iniziale può essere `FUNERAL SMART <onboarding@resend.dev>`; in produzione è obbligatorio un indirizzo appartenente a un dominio verificato in Resend. Se manca, il backend rifiuta l'invio invece di ricadere sul mittente di prova.

Non inserire mai la chiave in GitHub, nel frontend o in chat.

## Limite del mittente di prova

Il mittente `onboarding@resend.dev` è destinato ai test e può inviare soltanto all'indirizzo email proprietario dell'account Resend. Non consente di invitare colleghi o clienti. Per invii reali a terzi occorre verificare in Resend un dominio che si possiede e usare un mittente di quel dominio.

## Stato dell'integrazione

Il backend costruisce gli adattatori Resend e li passa alle route di verifica email e invito. Le route multi-azienda vengono montate soltanto con `ENABLE_MULTI_TENANT=true`, che resta disattivato in produzione finché non sono approvati migrazioni, backup/restore, test di isolamento e piano di rollback. Le chiavi e i segreti restano esclusivamente nelle variabili d'ambiente del servizio backend. Senza `EMAIL_VERIFICATION_PEPPER` di almeno 32 byte, richiesta e conferma dei codici email vengono rifiutate.

## Test

Eseguire `npm test`. I test usano un client HTTP simulato e non inviano email reali.
