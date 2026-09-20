# Usage credits

Balances reset at 00:00 UTC: groups receive 50 credits/day; users receive 20.
Normal group requests spend only the group balance. Bot DMs and guest requests
share a user balance. Guest commands in a private chat address that chat owner's
DM balance; guest commands in groups address the sender's user balance.

A request costs 1 credit. Each tool invocation costs 1 more; web search adds 1,
and each image API attempt adds 5 (including the alternate-model retry).
Charges happen before work and are retained on failure, cancellation, or failed
delivery. Model continuations/recovery for the same request aren't new requests.
Work that cannot afford its next charge is skipped. Troll/proactive triggers are
silent when credits run out. Commands themselves are free.

`/usage` shows today's spend and prices. Bot admins can adjust the persistent
daily allowance with `/usage +N` or `/usage -N` (minimum zero). `/usage +unlimited`
disables enforcement; `/usage -unlimited` restores the saved finite allowance.
Unlimited balances still accumulate spend, including when later switched back.
Existing per-kind tables are retained; the new credit tables start fresh.

Each successful debit emits a `credit_usage` OTel event containing numeric
`credits` and `usage_owner`, plus `credit_kind`, `usage_limit` (`limited` or
`unlimited`), `chat_type`, `mode`, and `tools`. Sum `credits`, not event counts.
These are consumption events rather than LLM success events, so failed attempts
are included. Use [the chart query](signoz-credit-consumption.sql) with the usual
`bucket`, `chat_type`, `mode`, `tools` variables and a new `usage_limit` variable
of type **Custom**. Enter `__all__,unlimited,limited` as its comma-separated
values (without quotes), save it, and select `__all__` in the dashboard dropdown.
The variable name is `usage_limit`, without a dollar sign. Custom dropdowns
use this explicit list; they are not populated from telemetry. Empty selections
also mean all balances in the query.
The filter uses the balance's setting at charge time, not its present setting.

Set the panel legend to `{{__name__}}` in the panel editor, not in the SQL.
SigNoz parses template expressions even inside SQL comments; including that
legend expression in a query causes “error while replacing template variables”.
