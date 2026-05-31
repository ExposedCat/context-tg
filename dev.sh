#!/bin/bash

DEBUG=${DEBUG:-"app:*"} deno run --watch --allow-ffi --env-file=.env -INERSW src/app.ts
