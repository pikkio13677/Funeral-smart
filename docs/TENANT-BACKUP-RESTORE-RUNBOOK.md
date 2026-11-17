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
