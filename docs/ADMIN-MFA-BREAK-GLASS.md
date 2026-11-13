# Procedura di emergenza MFA — account amministratore unico

## Stato

Questa è una procedura operativa proposta, non un endpoint automatico. Non abilita un bypass self-service e non deve essere eseguita finché non è stata approvata, provata su un database temporaneo e assegnata a un operatore autorizzato.

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
- Non esiste una seconda approvazione interna perché al momento è previsto un solo amministratore.
- Questa documentazione non contiene una query SQL pronta per la produzione: la transazione dovrà essere realizzata, revisionata e testata in un'attività separata prima che il recupero possa essere dichiarato operativo.
- Fino a quel momento, la perdita di tutti i fattori richiede assistenza manuale autorizzata e non deve essere risolta con modifiche improvvisate al database.
- La procedura non autorizza merge, deploy, migrazioni o modifiche al database di produzione.
