#!/bin/bash

DEBUG=${DEBUG:-"app:*"} deno run --watch --allow-run --allow-ffi --env-file=.env -INERSW --unstable-cron src/app.ts
