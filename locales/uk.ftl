command-configure-description = Змінити налаштування чату
command-debug-description = Увімкнути або вимкнути налагодження
command-stickers-description = Показати стікерпаки
command-packs-description = Показати набори емодзі
command-tasks-description = Показати останні завдання
command-schedule-description = Показати майбутні повідомлення
command-usage-description = Показати ліміти

settings-model-usage = Приклад: /model {$options} НАЗВА_МОДЕЛІ
settings-debug-usage = Приклад: /debug on|off
settings-interval-usage = {$command} N|off — N — ціле число від 1 до {$max}
settings-interval-status-enabled = {$count}
settings-interval-status-disabled = вимкнено (останній інтервал: {$count})
settings-current-value = Поточне значення: {$value}

settings-value-null = За замовчуванням
settings-value-none = Немає
settings-value-minimal = Мінімальна
settings-value-low = Низька
settings-value-medium = Середня
settings-value-high = Висока
settings-value-xhigh = Дуже висока
settings-value-off = Вимкнено
settings-value-on = Увімкнено

settings-kind-debug = Налагодження
settings-kind-debug-global = Налагодження для всіх чатів
settings-kind-reasoning = Глибина міркувань
settings-kind-reasoning-global = Спільна глибина міркувань

settings-configure-global-title = Налаштування для всіх чатів:
settings-configure-menu =
    Стікери /stickers
    Емодзі /packs
    Тролінг /trolling
    Проактивні відповіді /proactive
settings-configure-menu-admin =
    Стікери /stickers
    Емодзі /packs
    Моделі /model
    Налагодження /debug
    Тролінг /trolling
    Проактивні відповіді /proactive
settings-admin-warning-global = Змінювати налаштування для всіх чатів може лише адміністратор бота.
settings-admin-warning-chat = Попросіть адміністратора бота або групи змінити ці налаштування.

settings-deployment-all = Усі
settings-model-small = Мала
settings-model-big = Велика
settings-model-openminded = Неупереджена
settings-model-image = Для зображень
settings-model-status-title = Поточні моделі:
settings-model-not-set = (не задано)
settings-model-admin-only = Змінювати моделі може лише адміністратор бота.
settings-model-updated = Тепер «{$model}» використовує «{$deployment}» в усіх чатах.

settings-debug-admin-only = Змінювати режим налагодження може лише адміністратор бота.
settings-debug-current = Поточний режим налагодження: {$value}
settings-debug-updated = Налагодження для цього чату: {$value}.

settings-error-unknown-configuration = Не розумію, що це за налаштування.
settings-error-debug-reasoning-admin-only = Змінювати налагодження та глибину міркувань може лише адміністратор бота.
settings-error-unknown-debug = Не розумію, що це за режим налагодження.
settings-error-unknown-reasoning = Не розумію, що це за глибина міркувань.
settings-choose-debug-mode = Налаштування «{$setting}». Виберіть значення:
settings-choose-deployment = Для якої моделі налаштувати параметр «{$setting}»?
settings-debug-set = «{$setting}»: {$value}.
settings-choose-reasoning = Виберіть значення параметра «{$setting}» для моделі «{$deployment}»:
settings-reasoning-set = «{$setting}» для моделі «{$deployment}»: {$value}.

settings-trolling-description = Я періодично перевірятиму, чи не час потролити. Шанс під час кожної перевірки — 25 %.
settings-trolling-disabled = Тролінг у цьому чаті вимкнено.
settings-trolling-updated =
    { $count ->
        [one] Перевірятиму, чи не час потролити, після кожного повідомлення. Шанс під час кожної перевірки — 25 %.
        [few] Перевірятиму, чи не час потролити, кожні {$count} повідомлення. Шанс під час кожної перевірки — 25 %.
       *[many] Перевірятиму, чи не час потролити, кожні {$count} повідомлень. Шанс під час кожної перевірки — 25 %.
    }
settings-proactive-description = Я періодично перевірятиму, чи не час відповісти самому. Шанс під час кожної перевірки — 25 %.
settings-proactive-disabled = Проактивні відповіді в цьому чаті вимкнено.
settings-proactive-updated =
    { $count ->
        [one] Перевірятиму, чи не час відповісти самому, після кожного повідомлення. Шанс під час кожної перевірки — 25 %.
        [few] Перевірятиму, чи не час відповісти самому, кожні {$count} повідомлення. Шанс під час кожної перевірки — 25 %.
       *[many] Перевірятиму, чи не час відповісти самому, кожні {$count} повідомлень. Шанс під час кожної перевірки — 25 %.
    }

settings-usage-title = Статистика за {$date}
settings-usage-category-text-responses = Текстові відповіді
settings-usage-category-tool-usages = Виклики інструментів
settings-usage-category-image-responses = Відповіді із зображеннями
settings-usage-line = {$category}: {$used}/{$quota}
settings-usage-usage =
    Приклад: /usage
    Приклад: /usage {$options} ЛІМІТ
settings-usage-admin-only = Змінювати ліміти може лише адміністратор бота.
settings-usage-updated = «{$category}»: новий ліміт — {$quota}.
