# Funeral Smart — procedura di restore e prova multi-azienda

**Solo ambiente isolato.** Questo documento non autorizza operazioni su Render, database live, merge o deploy.

## 1. Conservare il backup originale

- Conservare il dump originale e la copia cifrata separatamente.
- Lavorare su una copia locale del dump, mai sull'unico originale.
- Non caricare il dump, dati personali, password, cookie o segreti su GitHub.
- Verificare che il file sia un archivio PostgreSQL valido con `pg_restore --list`.

## 2. Creare un database di prova nuovo

Esempio per una macchina locale con PostgreSQL:

```bash
createdb funeral_smart_tenant_rehearsal
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname=funeral_smart_tenant_rehearsal /percorso/backup.dump
```

Non usare un URL Render o un hostname remoto. Il restore va eseguito in un database vuoto e separato.

## 3. Fotografia iniziale

Prima di applicare le bozze, registrare i conteggi delle nove tabelle gestionali:

- customers
- funeral_cases
- staff
- vehicles
- inventory_items
- stock_movements
- tasks
- invoices
- payments

Registrare inoltre il numero di utenti attivi per ruolo, le relazioni esistenti e gli eventuali record orfani. Non includere nomi, recapiti o dati dei defunti nel report condiviso.

## 4. Preparazione schema tenant

Sul clone locale, applicare in sequenza le migrazioni 005–011 con transazione per file. Non eseguire la 012 in questa fase.

Dopo 005–011, eseguire lo script read-only:

```bash
NODE_ENV=test DATABASE_URL=postgres://localhost/funeral_smart_tenant_rehearsal \
  node scripts/tenant-backfill-preflight.js
```

Il report deve essere conservato insieme ai conteggi iniziali. Le colonne `company_id` sono ancora nullable in questa fase.

## 5. Mappatura esplicita e backfill per una sola impresa

La proprietà dei dati legacy è stata indicata come una sola impresa. Sul clone ripristinato:
- creare/verificare una sola riga in `companies`, usando denominazione legale e dati aziendali corretti; il backfill non inventa la denominazione né la partita IVA;
- verificare che tutti i dati gestionali storici appartengano a quella stessa impresa;
- mantenere i ruoli legacy riconosciuti (`admin`, `manager`, `operator`, `warehouse`, `accounting`) e creare una membership per ciascun account; gli account inattivi ricevono membership sospesa;
- gli account `platform_owner` restano separati e non ricevono membership aziendale;
- collegare le sessioni esistenti alla membership dello stesso utente;
- lasciare invariati gli eventi storici di audit, che possono rimanere senza contesto aziendale.

Il nuovo script `scripts/backfill-single-company.js` è **dry-run per impostazione predefinita**. Funziona solo su PostgreSQL locale, richiede un `COMPANY_ID` esistente e verifica che esista esattamente una sola azienda. Per il dry-run:

```bash
NODE_ENV=test DATABASE_URL=postgres://localhost/funeral_smart_tenant_rehearsal \
  COMPANY_ID=UUID_AZIENDA node scripts/backfill-single-company.js --dry-run
```

Solo dopo aver esaminato il report, su un clone usa-e-getta, il backfill può essere provato con `--apply` e `CONFIRM_SINGLE_COMPANY_BACKFILL=YES`. Non usare mai un URL Render o un database remoto. L'operazione è transazionale e verifica i risultati prima del commit.

## 6. Verifica e finalizzazione

Dopo il backfill:
1. ripetere il preflight e verificare zero righe senza azienda;
2. verificare zero relazioni cross-company;
3. verificare le 8 FK composte e le 9 FK verso `companies`;
4. verificare la membership attiva di ogni utente aziendale;
5. applicare la bozza 012 soltanto sul clone;
6. verificare `company_id NOT NULL` sulle nove tabelle e i quattro indici unici per azienda;
7. eseguire i test PostgreSQL Alfa/Beta e la suite applicativa;
8. provare il rollback ripristinando il dump originale in un secondo database nuovo.

La migrazione 012 rimuove i vincoli globali su codice pratica, targa, SKU e numero fattura soltanto dopo la creazione e verifica dei corrispondenti indici unici per azienda.

## 7. Criterio di arresto

Se i conteggi non coincidono, una relazione è ambigua, manca una membership, un indice o una FK non è validata, fermarsi e non abilitare il multi-tenant. Nessuna variabile Render deve essere modificata in questa fase.

## 8. Integrità del backup cifrato e prova di ripristino

Questa sezione è una lista di controllo, non una dichiarazione che il backup cifrato sia già stato verificato.

1. Conservare intatto il file cifrato originale e lavorare su una copia.
2. Calcolare e registrare SHA-256 del file cifrato prima di qualsiasi operazione; ripetere il calcolo sulla copia e verificare che coincida.
3. Identificare il formato e il metodo di cifratura effettivamente usati per quel file. Non indovinare algoritmo, opzioni o formato e non salvare chiavi/passphrase nel repository, nei log o nella cronologia della shell.
4. Decifrare soltanto una copia in una cartella locale con permessi riservati. La chiave deve essere fornita localmente tramite il metodo sicuro previsto dallo strumento, mai incollata in chat o in GitHub.
5. Verificare il dump decifrato con `pg_restore --list`. Se il comando non riconosce l'archivio o segnala errori, fermarsi: non tentare un restore parziale.
6. Ripristinare il dump in un secondo database PostgreSQL locale, vuoto e usa-e-getta, distinto dal database usato per la migrazione.
7. Confrontare i conteggi delle tabelle e le sequenze con la fotografia iniziale; eseguire i controlli di integrità e i test applicativi previsti.
8. Registrare soltanto esito, data, versione dello schema e conteggi aggregati. Non condividere dump, dati personali, chiavi o passphrase.

## 9. Limiti del collaudo automatico e attività ancora aperte

- I workflow GitHub che passano su PostgreSQL usa-e-getta verificano schema, migrazioni draft, isolamento Alfa/Beta, bootstrap e API. **Non dimostrano** che un dump reale, né la sua copia cifrata, siano stati decifrati e ripristinati correttamente.
- La documentazione del repository indica ancora come attività da realizzare i backup automatici, la retention e i test periodici di ripristino. Non considerare quindi già disponibile un servizio automatico di backup solo perché il database è ospitato su Render.
- Il restore-test del backup effettivo, il controllo della copia cifrata e la verifica delle regole di conservazione restano gate separati. Devono essere eseguiti e documentati prima di qualsiasi cutover.
- Nessun test descritto in questa procedura autorizza l'uso del database di produzione, la modifica di Render, l'attivazione di flag tenant, il merge o il deploy.

