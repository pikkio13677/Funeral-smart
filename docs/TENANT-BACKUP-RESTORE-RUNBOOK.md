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

## 5. Mappatura esplicita e backfill

Prima di qualsiasi UPDATE:
- identificare l'azienda o le aziende proprietarie dei dati legacy;
- associare ogni utente attivo alla membership corretta;
- definire una mappatura esplicita per ciascuna tabella gestionale;
- non dedurre la proprietà da nomi, ID casuali o partita IVA di provider marketplace;
- verificare tutte le relazioni cliente/pratica/personale/articolo/fattura/pagamento.

Il backfill va eseguito in una sola transazione sul clone, con conteggi prima/dopo e rollback automatico in caso di qualsiasi mismatch. Non esiste un mapping approvato incorporato in questo repository: la migrazione non deve inventarlo.

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
