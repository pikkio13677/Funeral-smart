# FUNERAL SMART — Backup e ripristino PostgreSQL

## Scopo e regole di sicurezza

Questa procedura serve a creare una copia verificabile del database e a provare il ripristino in un database separato. I backup contengono dati personali e operativi delle famiglie: trattarli come dati riservati.

- Non salvare dump nel repository Git o in cartelle pubbliche.
- Non incollare URL del database, password o chiavi in chat, ticket o log.
- Conservare i backup cifrati, con accesso limitato e una retention approvata dal titolare del trattamento.
- Non eseguire mai i comandi di ripristino su `funeral-smart-db` o su un database di produzione.
- Non abilitare `ENABLE_MULTI_TENANT` in produzione sulla sola base del buon esito di un dump.

## 1. Creare un backup manuale

Usare una macchina amministrativa fidata con PostgreSQL client (`pg_dump`, `pg_restore`, `psql`) aggiornato. Recuperare il connection string privato dal pannello Render senza condividerlo e impostarlo solo nella sessione locale come `DATABASE_URL`.

Esempio shell:

```bash
umask 077
mkdir -p "$HOME/funeral-smart-backups"
BACKUP="$HOME/funeral-smart-backups/funeral-smart-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-acl --file="$BACKUP" "$DATABASE_URL"
pg_restore --list "$BACKUP" >/dev/null
sha256sum "$BACKUP" > "$BACKUP.sha256"
```

Il comando termina con errore se il dump non può essere creato. Conservare insieme il file e il relativo checksum. Cifrare il file prima di trasferirlo o archiviarlo fuori dalla macchina fidata. Non usare un servizio pubblico di condivisione file.

## 2. Ripristino di prova — solo database temporaneo

Creare prima un database PostgreSQL temporaneo e vuoto, non collegato al servizio Render di produzione. Impostare il suo connection string come `RESTORE_DATABASE_URL`.

Verificare che la destinazione sia quella temporanea e controllare il checksum:

```bash
sha256sum -c "$BACKUP.sha256"
pg_restore --list "$BACKUP" | head
```

Ripristinare nel database temporaneo:

```bash
pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" "$BACKUP"
```

Non aggiungere opzioni di cancellazione o pulizia automatica. Se la destinazione non è vuota, interrompere e crearne una nuova anziché sovrascriverla.

## 3. Verifiche dopo il ripristino

Eseguire almeno questi controlli sul database temporaneo:

```bash
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT current_database(), current_timestamp;"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT id, applied_at FROM schema_migrations ORDER BY id;"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS companies FROM companies;"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS memberships FROM company_memberships;"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS users FROM app_users;"
```

Controllare inoltre i conteggi dei reparti gestionali, l'integrità dei vincoli e che i dati di aziende differenti restino separati. Avviare una copia dell'applicazione configurata esclusivamente sul database temporaneo e verificare login, MFA, selezione azienda, letture e una scrittura di prova. Non inviare email reali: usare un mittente mock/test.

Registrare data, versione/commit dell'app, dimensione del dump, checksum, durata del backup, durata del restore, esito dei controlli e responsabile della prova. Una prova non è superata se il database ripristinato non può essere letto dall'applicazione o se i conteggi non sono spiegabili.

## 4. Frequenza, conservazione e responsabilità

Prima di usare dati reali, il titolare deve approvare:
- frequenza dei backup e obiettivi RPO/RTO;
- retention e cancellazione sicura;
- cifratura a riposo e in transito;
- luogo geografico e accessi all'archivio;
- procedura di notifica e responsabilità in caso di perdita dati.

Verificare nel pannello Render le funzionalità di backup effettivamente incluse nel piano attivo. Non presumere che un piano gratuito fornisca backup automatici, point-in-time recovery o una retention specifica. Se disponibili, abilitarle e documentarne la configurazione; mantenere comunque una copia indipendente verificata secondo la policy approvata.

## 5. Criterio di rilascio

Il rilascio multi-azienda resta bloccato finché:
1. esiste un backup recente e verificabile;
2. il ripristino è stato completato con successo su un database temporaneo;
3. i test di isolamento tra almeno due aziende passano sul database ripristinato;
4. sono stati approvati RPO/RTO, retention e accessi;
5. il piano di rollback applicativo e database è stato provato.

Questa guida non esegue backup né ripristini automaticamente e non autorizza modifiche al database di produzione.
