# Track Republic

This workspace is organized into four main areas:

- `src/`: Next.js dashboard and local Ollama assistant
- `scripts/`: PDF conversion and transaction classification pipeline
- `data/raw/`: local statement imports only, gitignored
- `data/processed/`: local generated CSV and cache outputs, gitignored
- `config/`: registry plus local override files

The dashboard reads local files from `data/processed/` when they exist. In a fresh checkout, the app starts empty until you import your own statement data.

## Folder layout

```text
.
├── config/
│   └── manual_category_rules.csv
├── data/
│   ├── processed/
│   └── raw/
├── scripts/
│   ├── categorize_transactions.py
│   └── convert_trade_republic_statement.py
└── src/
    ├── app/
    ├── components/
    └── lib/
```

## Usage

Run it from this folder:

```bash
./scripts/convert_trade_republic_statement.py /path/to/statement.pdf --output-dir data/processed
```

Or with an explicit output directory and filename prefix:

```bash
./scripts/convert_trade_republic_statement.py /path/to/statement.pdf --output-dir /path/to/output --prefix 2026-03
```

## Output files

The script writes three CSV files:

- `<prefix>_transactions.csv`
- `<prefix>_money_market_fund.csv`
- `<prefix>_all_rows.csv`

## Notes

- It uses macOS `PDFKit` through `swift`, so it should be run on macOS.
- It is tailored to the Trade Republic statement layout.
- The transaction CSV includes `signed_amount_eur`, `payment_in_eur`, `payment_out_eur`, and `balance_eur`.

## Categorize Transactions

You can classify the generated transaction CSV with a local Ollama model such as `qwen3.5:9b`:

```bash
./scripts/categorize_transactions.py data/processed/statement_transactions.csv
```

Optional flags:

```bash
./scripts/categorize_transactions.py data/processed/statement_transactions.csv --model qwen3.5:9b --batch-size 20
```

For recurring runs, `qwen3.5:4b` is usually much faster. `qwen3.5:9b` is the better choice when you want more careful classifications and do not mind the extra runtime.

You can also add hard overrides in `config/manual_category_rules.csv`. The file is loaded automatically. Each row can match by `contains`, `exact`, or `regex` and overrides the cache + LLM for those descriptions.

Example:

```csv
name,match_type,pattern,transaction_type,amount_sign,merchant,group,category,subcategory,confidence,needs_review
Netflix,contains,NETFLIX,,expense,Netflix,expense,subscriptions,video_streaming,0.99,false
Rent,contains,Outgoing transfer for Landlord,,expense,Landlord,expense,housing,rent,0.99,false
```

This is the general way to handle recurring exceptions that look like transfers but are really bills, for example rent paid to a person. Keep the broad `category` stable, such as `housing`, and put the more specific meaning into `subcategory`, such as `rent`.

This writes into `data/processed/`:

- `statement_transactions_categorized.csv`
- `statement_transactions_needs_review.csv`
- `statement_transactions_monthly_overview.csv`
- `statement_transactions_yearly_overview.csv`
- `statement_transactions_monthly_categories.csv`
- `statement_transactions_yearly_categories.csv`
- `statement_transactions_category_cache.json`

The categorizer uses a hybrid approach:

- manual rules from `config/manual_category_rules.csv`
- rules for obvious rows like trades, taxes, interest, cashback, and self-transfers
- local LLM classification for merchant and counterparty rows
- recurring-payment detection that marks `is_recurring`, `is_fixed_cost`, and `cashflow_bucket`
- a persistent cache so repeated runs do not reclassify the same descriptions

## Next.js Dashboard

The main dashboard now lives in a local Next.js app that reads local CSV files from `data/processed/` when present.

Install and run it:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

On a clean clone with no imported data yet, the app opens with empty states until you run the pipeline or import a statement from the UI.

The app includes:

- `/`: Overview
- `/spending`: Spending analysis, recurring bills, and transactions to check
- `/accounts`: Available cash, reserve-fund activity, and invested money
- `/assistant`: Chat with your data through Ollama and generate charts or transaction tables

The dashboard uses:

- `statement_transactions_categorized.csv`
- `statement_transactions.csv`
- `statement_money_market_fund.csv`

The assistant route uses the local Ollama API at `http://127.0.0.1:11434` and defaults to `qwen3.5:9b`. It can summarize the data, list matching transactions, and render bar, line, combo, or pie charts directly from the CSV files.

## Desktop App (Tauri)

You can also run the dashboard as a local desktop app from this same folder:

```bash
npm install
npm run desktop
```

That starts the Next app on `http://127.0.0.1:3210` and opens it inside a native Tauri window.

Useful commands:

```bash
npm run desktop
npm run desktop:check
```

This desktop setup is meant for local use from the repository checkout. It is a native shell around the existing Next.js app, not a separate exported static site.
