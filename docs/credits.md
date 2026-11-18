# Usage credits

Balances reset at 00:00 UTC: groups receive 50 credits/day; users receive 20.
Group requests, including guest requests, spend the group balance. Private
requests spend the sender's personal balance, including when the bot is a guest
in a DM between users. `/usage` reports the group balance or the sender's personal
balance, respectively.

Messages and replies from `ADMIN_ID` skip all credit charges, including text,
tools and images. The admin's personal `/usage` shows `0.00 / ∞`. Existing
balance records remain stored. Earlier charges to group and other user balances
still apply until the next daily reset.

A request costs 1 credit, plus 1 per 620 assistant text tokens (progress and final
answers). Each tool invocation costs 1 more; web search adds 1,
and each image API attempt adds 5 (including the alternate-model retry).
Charges happen before work and are retained on failure, cancellation, or failed
delivery. Model continuations/recovery for the same request aren't new requests.
Text charges are flushed in 128-token batches or after one second on the next
stream event, and at completion, cancellation or failure. No credits are
reserved for future output, so tasks can run in parallel. When the shared
balance runs out, active tasks stop further work and get one final model turn
with all tools disabled. Finite usage caps at 100% of the quota; small overlaps
and final wrap-up text do not push it above the limit. New requests are rejected
with a daily-limit or actual-shortage message. `/usage` and credit errors show
two decimal places. Commands themselves are free.

The per-request tool-call budget also forces a final turn without tools.
Troll/proactive triggers are silent when credits run out.

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
