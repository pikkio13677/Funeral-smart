# Backup cifrato PostgreSQL — procedura di verifica e ripristino

> Procedura operativa interna. Non è una procedura da eseguire sul database PostgreSQL di produzione. Le prove di ripristino vanno eseguite esclusivamente su un database locale temporaneo e usa-e-getta.

## Backup verificato il 13 novembre 2026

Per il file `funeral-smart-20261112-175532.dump (1).enc` sono stati verificati:

- contenitore OpenSSL con intestazione `Salted__`;
- cifratura AES-256-CBC;
- derivazione password PBKDF2 con 200.000 iterazioni;
- decrittografia riuscita inserendo la passphrase al prompt locale (mai nella riga di comando o in chat);
- archivio PostgreSQL in formato custom riconosciuto da `pg_restore -l`;
- ripristino di prova completato con PostgreSQL 18.2 in un database locale temporaneo, usando `--verbose --exit-on-error --no-owner --no-privileges`;
- controllo delle 20 tabelle pubbliche di base completato.

Il comando di cifratura usato per questo backup è stato:

```sh
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -in backup.dump -out backup.dump.enc
```

La procedura di decrittografia corrispondente è:

```sh
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in backup.dump.enc -out backup-restored.dump
```

OpenSSL chiede la password interattivamente. Non aggiungere `-pass`, non inserire la password nel comando, non salvarla in script o log e non comunicarla in chat. Il digest non è fissato in questo documento perché non è stato registrato nella verifica storica: non aggiungere un'opzione `-md` arbitraria ai comandi di questo specifico backup.

## Verifica dopo la decrittografia

1. Controllare che il comando OpenSSL termini senza errore.
2. Verificare che il file risultante non sia vuoto.
3. Leggere l'indice dell'archivio:

```sh
pg_restore -l backup-restored.dump > /dev/null
```

Se `pg_restore` restituisce un errore, fermarsi: non tentare un ripristino e non sovrascrivere altri file.

## Ripristino di prova isolato

Creare un database locale temporaneo vuoto, ad esempio:

```sh
createdb funeral_restore_test
pg_restore --verbose --exit-on-error --no-owner --no-privileges --dbname=funeral_restore_test backup-restored.dump
```

Dopo il ripristino, verificare le tabelle e i conteggi attesi rispetto al manifest del backup. Al termine, arrestare il cluster temporaneo e rimuovere il database di prova secondo la procedura locale.

Non usare `DATABASE_URL` di Render, non collegarsi al database di produzione e non eseguire questo ripristino su un database esistente. Non usare opzioni distruttive come `--clean` o `--create` nella procedura di verifica.

## Integrità e conservazione

- Conservare separatamente il file cifrato e la passphrase; la passphrase non deve stare accanto al backup.
- Per verificare trasferimenti o copie, confrontare localmente gli hash SHA-256 calcolati sulla stessa versione del file.
- Limitare l'accesso ai backup e alle copie decrittografate; cancellare in modo sicuro le copie temporanee non più necessarie.
- Registrare data, versione, esito di `pg_restore -l`, versione PostgreSQL e risultato del ripristino di prova.
- La verifica di un singolo backup non dimostra che esistano backup automatici recenti, retention adeguata, copie off-site o monitoraggio degli errori. Questi aspetti restano da definire e collaudare.

## Stato e limiti della verifica storica

Il backup del 12 novembre 2026 è stato decrittografato e ripristinato con successo in ambiente locale temporaneo il 13 novembre 2026. Il test ha incluso le 20 tabelle pubbliche di base. Questo documento registra tale esito; non attesta un nuovo test eseguito oggi né la conformità completa della strategia di disaster recovery.
