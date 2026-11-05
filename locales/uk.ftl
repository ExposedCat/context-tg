command-settings-description = Змінити налаштування чату й особисті налаштування
command-debug-description = Увімкнути або вимкнути налагодження
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
    Емодзі /packs
    Тролінг /trolling
    Проактивні відповіді /proactive
settings-configure-menu-admin =
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
settings-model-judge = Суддя
settings-model-image = Резервна
settings-model-image_small = Зображення: мала
settings-model-image_big = Зображення: велика
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

settings-trolling-description = На кожному заданому інтервалі генеруватиму відповідь для тролінгу й надсилатиму її лише після перевірки якості.
settings-trolling-disabled = Тролінг у цьому чаті вимкнено.
settings-trolling-updated =
    { $count ->
        [one] Генеруватиму відповідь після кожного повідомлення й надсилатиму її лише після перевірки якості.
        [few] Генеруватиму відповідь кожні {$count} повідомлення й надсилатиму її лише після перевірки якості.
       *[many] Генеруватиму відповідь кожні {$count} повідомлень й надсилатиму її лише після перевірки якості.
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
settings-usage-line = Використано кредитів: {$used} / {$quota}
settings-usage-usage = /usage · /usage +N · /usage -N · /usage +unlimited · /usage -unlimited
settings-usage-admin-only = Змінювати ліміти може лише адміністратор бота.
settings-usage-prices =
    Запит · 1 кредит
    Текст агента · 1 кредит за {$tokens} токенів (прогрес + підсумкова відповідь)
    Виклик інструмента · 1 кредит
    Вебпошук · +1 кредит
    Генерація зображення · +5 кредитів за спробу (включно з повторами)
    Скидання щодня о 00:00 UTC.

configure-button = Налаштувати
configure-finance-mcp = Finance MCP
configure-calendar-mcp = Calendar MCP
command-calendar-description = Підключити Google Календар до цього чату
calendar-help-title = Підключення Google Календаря
calendar-help-share-title = 1. Відкрийте доступ до календаря
calendar-help-share = Додайте цю адресу в налаштуваннях доступу календаря з правом «Змінювати події»:
calendar-help-no-account = Адресу для доступу можна дізнатися в адміністратора бота.
calendar-help-id-title = 2. Скопіюйте ID календаря
calendar-help-id = Google Календар → Налаштування → ваш календар → Інтеграція календаря → Ідентифікатор календаря
calendar-help-connect-title = 3. Підключіть цей чат
calendar-help-enable = Потім увімкніть:
calendar-challenge-title = Перевірка календаря
calendar-challenge-calendar = Календар
calendar-challenge = Створіть у цьому календарі нову подію на сьогодні ({$day}) з точною назвою:
calendar-challenge-event = Без гостей і повторень.
calendar-challenge-expiry = Натисніть «Перевірити» протягом 10 хвилин.
calendar-challenge-access = Це підтверджує можливість редагування. Якщо Calendar MCP увімкнено для цього чату, календарем можуть користуватися всі учасники.
calendar-verify = Перевірити
calendar-verifying = Перевіряю календар…
calendar-verification-failed = Поки не підтверджено
calendar-configured = Календар «{$name}» налаштовано для цього чату
calendar-error = {$error}
calendar-wrong-verification = Перевірити може лише той, хто почав налаштування. Для нового налаштування використайте /calendar ID.
configure-user-settings-own = Відкрийте /settings, щоб змінити власні налаштування користувача.
configure-enabled = Увімкнено
configure-disabled = Вимкнено
configure-emoji = Емодзі
configure-models = Моделі
configure-trolling = Тролінг
configure-proactive = Проактивні відповіді
configure-effort = Зусилля
configure-remove = Видалити
configure-no-emoji = Немає наборів емодзі.
configure-kind = Тип
configure-deployment = Розгортання
configure-model-usage = Використовуйте /model Тип Розгортання
configure-trolling-description = Кожне {$count}-те повідомлення запускає генерацію тролінгу. Відповідь надсилається лише після перевірки якості.
configure-proactive-description = Кожне {$count}-те повідомлення отримає відповідь з імовірністю 25%.
configure-all = Налаштувати всі
configure-back = Назад

configure-trolling-mode = Режим тролінгу
trolling-mode-aggressive = Агресивний
trolling-mode-mild = М’який
trolling-mode-clean = Без обзивань

configure-progress = Оновлення перебігу роботи
