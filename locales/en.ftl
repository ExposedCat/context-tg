command-configure-description = Change chat settings
command-debug-description = Turn debug details on or off
command-stickers-description = List sticker packs
command-packs-description = List emoji packs
command-tasks-description = Show recent tasks
command-schedule-description = Show upcoming messages
command-usage-description = Show usage limits

settings-model-usage = Try: /model {$options} DEPLOYMENT_NAME
settings-debug-usage = Try: /debug on|off
settings-interval-usage = {$command} N|off — N is a whole number from 1 to {$max}
settings-interval-status-enabled = {$count}
settings-interval-status-disabled = off (last interval: {$count})
settings-current-value = Current value: {$value}

settings-value-null = Default
settings-value-none = None
settings-value-minimal = Minimal
settings-value-low = Low
settings-value-medium = Medium
settings-value-high = High
settings-value-xhigh = Extra high
settings-value-off = Off
settings-value-on = On

settings-kind-debug = Debug
settings-kind-debug-global = Global Debug
settings-kind-reasoning = Reasoning effort
settings-kind-reasoning-global = Global reasoning effort

settings-configure-global-title = Settings for all chats:
settings-configure-menu =
    Stickers /stickers
    Emoji /packs
    Trolling /trolling
    Proactive responses /proactive
settings-configure-menu-admin =
    Stickers /stickers
    Emoji /packs
    Models /model
    Debug /debug
    Trolling /trolling
    Proactive responses /proactive
settings-admin-warning-global = Only the bot admin can change settings for all chats.
settings-admin-warning-chat = Ask the bot admin or a group admin to change these settings.

settings-deployment-all = All
settings-model-small = Small
settings-model-big = Big
settings-model-openminded = Open-Minded
settings-model-image = Image
settings-model-status-title = Current models:
settings-model-not-set = (not set)
settings-model-admin-only = Only the bot admin can change models.
settings-model-updated = {$model} now uses {$deployment} in all chats.

settings-debug-admin-only = Only the bot admin can change debug mode.
settings-debug-current = Current debug mode: {$value}
settings-debug-updated = Debug mode is now {$value} for this chat.

settings-error-unknown-configuration = I don't recognize that setting.
settings-error-debug-reasoning-admin-only = Only the bot admin can change debug and reasoning settings.
settings-error-unknown-debug = I don't recognize that debug option.
settings-error-unknown-reasoning = I don't recognize that reasoning option.
settings-choose-debug-mode = Choose a value for {$setting}:
settings-choose-deployment = Which model should use {$setting}?
settings-debug-set = {$setting} is now {$value}.
settings-choose-reasoning = Choose {$setting} for {$deployment}:
settings-reasoning-set = {$setting} for {$deployment} is now {$value}.

settings-trolling-description = I'll periodically check whether to send a trolling reply. Each check has a 25% chance of triggering.
settings-trolling-disabled = Trolling is off for this chat.
settings-trolling-updated =
    { $count ->
        [one] I'll check for a trolling reply after every message. Each check has a 25% chance of triggering.
       *[other] I'll check for a trolling reply every {$count} messages. Each check has a 25% chance of triggering.
    }
settings-proactive-description = I'll periodically check whether to send a proactive reply. Each check has a 25% chance of triggering.
settings-proactive-disabled = Proactive replies are off for this chat.
settings-proactive-updated =
    { $count ->
        [one] I'll check for a proactive reply after every message. Each check has a 25% chance of triggering.
       *[other] I'll check for a proactive reply every {$count} messages. Each check has a 25% chance of triggering.
    }

settings-usage-title = Usage for {$date}
settings-usage-category-text-responses = Text responses
settings-usage-category-tool-usages = Tool uses
settings-usage-category-image-responses = Image responses
settings-usage-line = {$category}: {$used}/{$quota}
settings-usage-usage =
    Try: /usage
    Try: /usage {$options} LIMIT
settings-usage-admin-only = Only the bot admin can change usage limits.
settings-usage-updated = {$category} limit is now {$quota}.
