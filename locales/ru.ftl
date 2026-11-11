command-settings-description = Изменить настройки чата и личные настройки
command-debug-description = Включить или выключить отладку
command-packs-description = Показать наборы эмодзи
command-tasks-description = Показать последние задачи
command-schedule-description = Показать будущие сообщения
command-usage-description = Показать лимиты

settings-model-usage = Пример: /model {$options} ИМЯ_МОДЕЛИ
settings-debug-usage = Пример: /debug on|off
settings-interval-usage = {$command} N|off — N — целое число от 1 до {$max}
settings-interval-status-enabled = {$count}
settings-interval-status-disabled = выключено (последний интервал: {$count})
settings-current-value = Текущее значение: {$value}

settings-value-null = По умолчанию
settings-value-none = Нет
settings-value-minimal = Минимальная
settings-value-low = Низкая
settings-value-medium = Средняя
settings-value-high = Высокая
settings-value-xhigh = Очень высокая
settings-value-off = Выключено
settings-value-on = Включено

settings-kind-debug = Отладка
settings-kind-debug-global = Отладка для всех чатов
settings-kind-reasoning = Глубина рассуждений
settings-kind-reasoning-global = Общая глубина рассуждений

settings-configure-global-title = Настройки для всех чатов:
settings-configure-menu =
    Эмодзи /packs
    Троллинг /trolling
    Проактивные ответы /proactive
settings-configure-menu-admin =
    Эмодзи /packs
    Модели /model
    Отладка /debug
    Троллинг /trolling
    Проактивные ответы /proactive
settings-admin-warning-global = Менять настройки для всех чатов может только администратор бота.
settings-admin-warning-chat = Попросите администратора бота или группы изменить эти настройки.

settings-deployment-all = Все
settings-model-small = Маленькая
settings-model-big = Большая
settings-model-openminded = Непредвзятая
settings-model-judge = Судья
settings-model-image = Резервная
settings-model-image_small = Изображения: маленькая
settings-model-image_big = Изображения: большая
settings-model-status-title = Текущие модели:
settings-model-not-set = (не задано)
settings-model-admin-only = Менять модели может только администратор бота.
settings-model-updated = Теперь «{$model}» использует «{$deployment}» во всех чатах.

settings-debug-admin-only = Менять режим отладки может только администратор бота.
settings-debug-current = Текущий режим отладки: {$value}
settings-debug-updated = Отладка для этого чата: {$value}.

settings-error-unknown-configuration = Не понимаю, что это за настройка.
settings-error-debug-reasoning-admin-only = Менять отладку и глубину рассуждений может только администратор бота.
settings-error-unknown-debug = Не понимаю, что это за режим отладки.
settings-error-unknown-reasoning = Не понимаю, что это за глубина рассуждений.
settings-choose-debug-mode = Настройка «{$setting}». Выберите значение:
settings-choose-deployment = Для какой модели настроить параметр «{$setting}»?
settings-debug-set = «{$setting}»: {$value}.
settings-choose-reasoning = Выберите значение параметра «{$setting}» для модели «{$deployment}»:
settings-reasoning-set = «{$setting}» для модели «{$deployment}»: {$value}.

settings-trolling-description = На каждом заданном интервале буду придумывать ответ для троллинга и отправлять его только после проверки качества.
settings-trolling-disabled = Троллинг в этом чате выключен.
settings-trolling-updated =
    { $count ->
        [one] Буду придумывать ответ после каждого сообщения и отправлять его только после проверки качества.
        [few] Буду придумывать ответ каждые {$count} сообщения и отправлять его только после проверки качества.
       *[many] Буду придумывать ответ каждые {$count} сообщений и отправлять его только после проверки качества.
    }
settings-proactive-description = Я буду периодически проверять, не пора ли ответить самому. Шанс на каждой проверке — 25 %.
settings-proactive-disabled = Проактивные ответы в этом чате выключены.
settings-proactive-updated =
    { $count ->
        [one] Буду проверять, не пора ли ответить самому, после каждого сообщения. Шанс на каждой проверке — 25 %.
        [few] Буду проверять, не пора ли ответить самому, каждые {$count} сообщения. Шанс на каждой проверке — 25 %.
       *[many] Буду проверять, не пора ли ответить самому, каждые {$count} сообщений. Шанс на каждой проверке — 25 %.
    }

settings-usage-title = Статистика за {$date}
settings-usage-line = Использовано кредитов: {$used} / {$quota}
settings-usage-usage = /usage · /usage +N · /usage -N · /usage +unlimited · /usage -unlimited
settings-usage-admin-only = Менять лимиты может только администратор бота.
settings-usage-prices =
    Запрос · 1 кредит
    Текст агента · 1 кредит за {$tokens} токенов (прогресс + итоговый ответ)
    Вызов инструмента · 1 кредит
    Веб-поиск · +1 кредит
    Генерация изображения · +5 кредитов за попытку (включая повторы)
    Сброс ежедневно в 00:00 UTC.

configure-button = Настроить
configure-finance-mcp = Finance MCP
configure-calendar-mcp = Calendar MCP
command-calendar-description = Подключить Google Календарь к этому чату
calendar-help-title = Подключение Google Календаря
calendar-help-share-title = 1. Откройте доступ к календарю
calendar-help-share = Добавьте этот адрес в настройках доступа календаря с правом «Внесение изменений в мероприятия»:
calendar-help-no-account = Адрес для доступа можно узнать у администратора бота.
calendar-help-id-title = 2. Скопируйте ID календаря
calendar-help-id = Google Календарь → Настройки → ваш календарь → Интеграция календаря → Идентификатор календаря
calendar-help-connect-title = 3. Подключите этот чат
calendar-help-enable = Затем включите:
calendar-challenge-title = Проверка календаря
calendar-challenge-calendar = Календарь
calendar-challenge = Создайте в этом календаре новое мероприятие на сегодня ({$day}) с точным названием:
calendar-challenge-event = Без гостей и повторений.
calendar-challenge-expiry = Нажмите «Проверить» в течение 10 минут.
calendar-challenge-sync = После сохранения дайте Google несколько секунд на синхронизацию. Если событие ещё не найдено, немного подождите и снова нажмите «Проверить». Сохраните то же событие и название.
calendar-challenge-access = Это подтверждает возможность редактирования. Если Calendar MCP включён для этого чата, календарём могут пользоваться все участники.
calendar-verify = Проверить
calendar-verifying = Проверяю календарь…
calendar-verification-failed = Пока не подтверждено
calendar-configured = Календарь «{$name}» настроен для этого чата
calendar-error = {$error}
calendar-wrong-verification = Проверить может только тот, кто начал настройку. Для новой настройки используйте /calendar ID.
configure-user-settings-own = Откройте /settings, чтобы изменить свои настройки пользователя.
configure-enabled = Включено
configure-disabled = Выключено
configure-emoji = Эмодзи
configure-models = Модели
configure-trolling = Троллинг
configure-proactive = Проактивные ответы
configure-effort = Усилие
configure-remove = Удалить
configure-no-emoji = Нет наборов эмодзи.
configure-kind = Тип
configure-deployment = Развёртывание
configure-model-usage = Используйте /model Тип Развёртывание
configure-trolling-description = Каждое {$count}-е сообщение запускает генерацию троллинга. Ответ отправляется только после проверки качества.
configure-proactive-description = Каждое {$count}-е сообщение получит ответ с вероятностью 25%.
configure-all = Настроить все
configure-back = Назад

configure-trolling-mode = Режим троллинга
trolling-mode-aggressive = Агрессивный
trolling-mode-mild = Мягкий
trolling-mode-clean = Без обзывательств

configure-progress = Обновления о ходе работы
configure-router = Умные ответы (автовыбор уместности и модели)
settings-model-router = Маршрутизатор
banish-confirmation = Автоматические ответы изгнаны из этой темы или чата. Прямые обращения по-прежнему работают.
