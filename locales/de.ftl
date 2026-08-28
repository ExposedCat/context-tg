command-configure-description = Chat-Einstellungen ändern
command-debug-description = Debug-Modus ein- oder ausschalten
command-stickers-description = Stickerpacks anzeigen
command-packs-description = Emoji-Pakete anzeigen
command-tasks-description = Letzte Aufgaben zeigen
command-schedule-description = Kommende Nachrichten zeigen
command-usage-description = Nutzungslimits zeigen

settings-model-usage = Beispiel: /model {$options} MODELLNAME
settings-debug-usage = Beispiel: /debug on|off
settings-interval-usage = {$command} N|off — N ist eine ganze Zahl von 1 bis {$max}
settings-interval-status-enabled = {$count}
settings-interval-status-disabled = aus (letztes Intervall: {$count})
settings-current-value = Aktueller Wert: {$value}

settings-value-null = Standard
settings-value-none = Keiner
settings-value-minimal = Minimal
settings-value-low = Niedrig
settings-value-medium = Mittel
settings-value-high = Hoch
settings-value-xhigh = Sehr hoch
settings-value-off = Aus
settings-value-on = Ein

settings-kind-debug = Debug-Modus
settings-kind-debug-global = Debug-Modus für alle Chats
settings-kind-reasoning = Denkaufwand
settings-kind-reasoning-global = Allgemeiner Denkaufwand

settings-configure-global-title = Einstellungen für alle Chats:
settings-configure-menu =
    Sticker /stickers
    Emoji /packs
    Trolling /trolling
    Proaktive Antworten /proactive
settings-configure-menu-admin =
    Sticker /stickers
    Emoji /packs
    Modelle /model
    Debug-Modus /debug
    Trolling /trolling
    Proaktive Antworten /proactive
settings-admin-warning-global = Nur der Bot-Admin kann die Einstellungen für alle Chats ändern.
settings-admin-warning-chat = Bitte einen Bot- oder Gruppen-Admin, diese Einstellungen zu ändern.

settings-deployment-all = Alle
settings-model-small = Klein
settings-model-big = Groß
settings-model-openminded = Aufgeschlossen
settings-model-image = Bilder
settings-model-status-title = Aktuelle Modelle:
settings-model-not-set = (nicht festgelegt)
settings-model-admin-only = Nur der Bot-Admin kann Modelle ändern.
settings-model-updated = „{$model}“ verwendet jetzt „{$deployment}“ in allen Chats.

settings-debug-admin-only = Nur der Bot-Admin kann den Debug-Modus ändern.
settings-debug-current = Aktueller Debug-Modus: {$value}
settings-debug-updated = Debug-Modus für diesen Chat: {$value}.

settings-error-unknown-configuration = Diese Einstellung kenne ich nicht.
settings-error-debug-reasoning-admin-only = Nur der Bot-Admin kann Debug-Modus und Denkaufwand ändern.
settings-error-unknown-debug = Diese Debug-Option kenne ich nicht.
settings-error-unknown-reasoning = Diese Stufe für den Denkaufwand kenne ich nicht.
settings-choose-debug-mode = Wert für „{$setting}“ auswählen:
settings-choose-deployment = Für welches Modell soll „{$setting}“ geändert werden?
settings-debug-set = „{$setting}“ ist jetzt „{$value}“.
settings-choose-reasoning = „{$setting}“ für „{$deployment}“ auswählen:
settings-reasoning-set = „{$setting}“ für „{$deployment}“ ist jetzt „{$value}“.

settings-trolling-description = Ich prüfe regelmäßig, ob eine Trolling-Antwort dran ist. Die Chance liegt bei jeder Prüfung bei 25 %.
settings-trolling-disabled = Trolling ist in diesem Chat aus.
settings-trolling-updated =
    { $count ->
        [one] Ich prüfe jetzt nach jeder Nachricht, ob eine Trolling-Antwort dran ist. Die Chance liegt bei jeder Prüfung bei 25 %.
       *[other] Ich prüfe jetzt alle {$count} Nachrichten, ob eine Trolling-Antwort dran ist. Die Chance liegt bei jeder Prüfung bei 25 %.
    }
settings-proactive-description = Ich prüfe regelmäßig, ob eine proaktive Antwort dran ist. Die Chance liegt bei jeder Prüfung bei 25 %.
settings-proactive-disabled = Proaktive Antworten sind in diesem Chat aus.
settings-proactive-updated =
    { $count ->
        [one] Ich prüfe jetzt nach jeder Nachricht, ob eine proaktive Antwort dran ist. Die Chance liegt bei jeder Prüfung bei 25 %.
       *[other] Ich prüfe jetzt alle {$count} Nachrichten, ob eine proaktive Antwort dran ist. Die Chance liegt bei jeder Prüfung bei 25 %.
    }

settings-usage-title = Nutzung am {$date}
settings-usage-category-text-responses = Textantworten
settings-usage-category-tool-usages = Werkzeugaufrufe
settings-usage-category-image-responses = Bildantworten
settings-usage-line = {$category}: {$used}/{$quota}
settings-usage-usage =
    Beispiel: /usage
    Beispiel: /usage {$options} LIMIT
settings-usage-admin-only = Nur der Bot-Admin kann Nutzungslimits ändern.
settings-usage-updated = Neues Limit für „{$category}“: {$quota}.
