command-configure-description = Изменить настройки чата
command-debug-description = Включить или выключить отладку
command-stickers-description = Показать стикерпаки
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
    Стикеры /stickers
    Эмодзи /packs
    Троллинг /trolling
    Проактивные ответы /proactive
settings-configure-menu-admin =
    Стикеры /stickers
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
settings-model-image = Для изображений
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

settings-trolling-description = Я буду периодически проверять, не пора ли потроллить. Шанс на каждой проверке — 25 %.
settings-trolling-disabled = Троллинг в этом чате выключен.
settings-trolling-updated =
    { $count ->
        [one] Буду проверять, не пора ли потроллить, после каждого сообщения. Шанс на каждой проверке — 25 %.
        [few] Буду проверять, не пора ли потроллить, каждые {$count} сообщения. Шанс на каждой проверке — 25 %.
       *[many] Буду проверять, не пора ли потроллить, каждые {$count} сообщений. Шанс на каждой проверке — 25 %.
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
settings-usage-category-text-responses = Текстовые ответы
settings-usage-category-tool-usages = Вызовы инструментов
settings-usage-category-image-responses = Ответы с изображениями
settings-usage-line = {$category}: {$used}/{$quota}
settings-usage-usage =
    Пример: /usage
    Пример: /usage {$options} ЛИМИТ
settings-usage-admin-only = Менять лимиты может только администратор бота.
settings-usage-updated = «{$category}»: новый лимит — {$quota}.
