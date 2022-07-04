#!/bin/sh
set -ex
rm -rf dist
tslint --project .
tsc -t ES2018 --lib "ES2018","DOM"
cp package.json package-lock.json dist
cd dist
npm install --only=prod
