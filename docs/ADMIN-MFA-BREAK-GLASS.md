# Procedura di emergenza MFA — account amministratore unico

## Stato

Questa procedura è supportata da una CLI offline, non da un endpoint automatico. Non abilita un bypass self-service e non deve essere eseguita in produzione finché non è stata approvata, provata su un database temporaneo e assegnata a un operatore autorizzato.

Il sistema può avere un solo account amministratore applicativo. In questo scenario non esiste una seconda persona interna che possa approvare il reset: la verifica deve quindi avvenire fuori dall'applicazione, tramite il titolare dell'account infrastrutturale e un canale di verifica indipendente già registrato.

## Quando usarla

Solo quando l'amministratore ha perso contemporaneamente:
- accesso all'app Authenticator;
- tutti i codici di recupero monouso.

Non usare questa procedura per un normale cambio telefono se è ancora disponibile un codice di recupero.

## Condizioni obbligatorie prima di qualsiasi intervento

1. Verificare l'identità del titolare tramite il canale aziendale indipendente già registrato e una verifica aggiuntiva del controllo dell'account proprietario Render. Non accettare richieste basate soltanto su username, password, messaggi in chat o accesso alla casella email da sola.
2. Verificare che l'account proprietario Render sia protetto da MFA e che l'operatore che esegue l'intervento sia autorizzato.
3. Aprire un ticket/verbale con data, motivo, identità verificata, operatore, approvatore esterno e riferimenti dell'intervento. Non inserire password, token, codici TOTP o segreti nel verbale.
4. Sospendere le modifiche applicative e predisporre un backup PostgreSQL verificabile secondo il runbook di backup/restore del repository. Non procedere se il backup non è stato verificato su un database temporaneo.
5. Identificare l'account tramite un identificativo stabile verificato; non selezionare account soltanto per nome visualizzato o username ambiguo.
6. Preparare e revisionare in anticipo una transazione database limitata al singolo account. La transazione dovrà revocare tutte le sessioni e le challenge MFA pendenti, azzerare il segreto TOTP attivo e quello pendente, rimuovere tutti gli hash dei codici di recupero e registrare l'evento di emergenza nell'audit log. Non eseguire aggiornamenti manuali ad hoc o comandi copiati da chat.
7. La transazione deve essere provata integralmente su una copia temporanea del database, inclusi rollback e verifica che gli altri account e i dati gestionali restino invariati.

## Ripristino controllato

Dopo l'approvazione e il test su database temporaneo, l'operatore autorizzato può eseguire la procedura approvata sul database di produzione soltanto con autorizzazione esplicita del titolare e registrazione dell'intervento.

Il reset deve lasciare l'account senza sessioni valide e senza fattori MFA precedenti. Al successivo accesso, l'amministratore dovrà:
1. autenticarsi con la password corrente;
2. configurare immediatamente una nuova app Authenticator;
3. confermare il nuovo codice TOTP;
4. conservare offline i nuovi codici di recupero, separati dal telefono;
5. verificare l'accesso con un codice nuovo e poi terminare la sessione di prova;
6. controllare il registro attività e confermare che le vecchie sessioni non siano più valide.

Se una qualsiasi verifica fallisce, interrompere l'operazione e ripristinare il backup secondo il runbook approvato. Non disattivare MFA globalmente e non creare un amministratore temporaneo.

## Limiti e stato di implementazione

- Non è presente alcun endpoint pubblico o self-service per resettare MFA.
- È stato aggiunto `scripts/reset-admin-mfa.js`: utility CLI offline che apre una transazione, blocca l'account selezionato, accetta soltanto un amministratore attivo, revoca sessioni e challenge, azzera TOTP e codici di recupero e registra l'evento nell'audit log. Se l'audit fallisce, l'intera transazione viene annullata.
- La CLI richiede identificativo UUID, operatore, ticket, riferimento del backup e nome esatto del database e ambiente (`test`, `staging` o `production`); verifica `current_database()` e richiede una conferma digitata esattamente. Per produzione richiede anche `--production` e `MFA_BREAK_GLASS_PRODUCTION_APPROVED=YES`.
- Il tool non viene eseguito automaticamente dal server e non espone alcuna route HTTP. Il test PostgreSQL usa uno schema temporaneo dedicato e verifica reset, isolamento di un altro account e rollback forzato.
- Non esiste una seconda approvazione interna perché al momento è previsto un solo amministratore.
- La transazione è ora implementata come CLI offline e coperta da test automatici. Resta non autorizzata l'esecuzione in produzione: prima servono revisione della PR, backup verificato, autorizzazione formale, prova in ambiente temporaneo e conferma esplicita del titolare.
- Fino a quel momento, la perdita di tutti i fattori richiede assistenza manuale autorizzata e non deve essere risolta con modifiche improvvisate al database.
- La procedura non autorizza merge, deploy, migrazioni o modifiche al database di produzione.

## Uso della CLI (solo operatore autorizzato)

La CLI va eseguita da un ambiente controllato con `DATABASE_URL` impostata fuori dalla chat e mai stampata nei log. Prima dell'uso verificare identità, ticket e backup secondo le condizioni sopra. Esempio per un database temporaneo:

```bash
node scripts/reset-admin-mfa.js \
  --target-user-id UUID_AMMINISTRATORE \
  --operator IDENTITA_OPERATORE \
  --ticket RIFERIMENTO_TICKET \
  --backup-reference RIFERIMENTO_BACKUP_VERIFICATO \
  --database-name NOME_DATABASE
```

Per produzione sostituire `--environment test` con `--environment production`, aggiungere `--production` e impostare `MFA_BREAK_GLASS_PRODUCTION_APPROVED=YES` soltanto dopo l'autorizzazione formale. La CLI chiede una frase di conferma che include ambiente, UUID e database. Il riferimento del backup deve corrispondere a un backup realmente verificato: la CLI non può verificarlo autonomamente.
