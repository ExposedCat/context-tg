#!/bin/bash

DEBUG=${DEBUG:-"app:*"} deno run --watch --env-file=.env -INERSW src/app.ts
