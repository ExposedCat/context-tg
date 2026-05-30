#!/bin/bash

DEBUG=${DEBUG:-"app:*"} deno run --watch --env-file=.env -INERS src/app.ts