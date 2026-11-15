# Variabili e invio email — FUNERAL SMART

Le variabili e i segreti sono configurati esclusivamente nel servizio backend Render. Non inserirli in GitHub, nel frontend, nei log o in chat.

## Variabili dichiarate nel Blueprint

- `ADMIN_API_KEY`: chiave legacy di compatibilità. Non deve essere esposta nel browser.
- `BOOTSTRAP_ADMIN_TOKEN`: token iniziale per il bootstrap dell'amministratore; configurarlo privatamente e ruotarlo/disattivarlo dopo il bootstrap secondo la procedura approvata.
- `TOTP_ENCRYPTION_KEY`: chiave stabile di 32 byte, rappresentata da 64 caratteri esadecimali, per cifrare i segreti MFA. Non ruotarla senza una procedura di migrazione e recupero.
- `EMAIL_VERIFICATION_PEPPER`: segreto casuale dedicato di almeno 32 byte per HMAC dei codici di verifica email. Non riutilizzare le altre chiavi.
- `CORS_ORIGIN`: soltanto le origini HTTPS autorizzate, separate da virgole.
- `PUBLIC_APP_URL`: URL HTTPS pubblico utilizzato per i link d'invito.
- `RESEND_API_KEY`: chiave API Resend con permesso Sending.
- `RESEND_FROM_EMAIL`: mittente autorizzato; per invii reali deve appartenere a un dominio verificato in Resend.
- `ADMIN_NOTIFICATION_EMAIL`: casella amministrativa destinataria delle notifiche operative.
- `ENABLE_MULTI_TENANT`: impostato esplicitamente a `false`. Non attivarlo finché migrazioni, isolamento, backup/restore, staging, MFA, ruoli e rollback non sono stati approvati.

I valori segreti sono dichiarati come variabili da fornire manualmente al servizio Render; il repository non contiene i loro valori.

## Invio email e staging

Il backend usa l'API HTTPS di Resend. Le chiavi restano sul server e non vengono mai inviate al browser. L'ambiente di staging usa un database distinto, imposta `STAGING_MODE=true` e blocca tutte le email in uscita, anche se le credenziali fossero presenti.

Il mittente di prova `onboarding@resend.dev` è limitato ai test e non consente invii generici a terzi. Per invii reali occorre verificare in Resend un dominio posseduto e usare un mittente di quel dominio.

## Verifica prima del lancio

- [ ] Verificare privatamente tutte le variabili richieste, senza condividerne i valori.
- [ ] Verificare SPF/DKIM del dominio mittente.
- [ ] Eseguire un test email controllato solo dopo autorizzazione esplicita.
- [ ] Mantenere `ENABLE_MULTI_TENANT=false` fino all'approvazione formale del rollout.
- [ ] Non applicare migrazioni draft al database di produzione durante i test.
