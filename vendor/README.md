# vendor

`xlsx-0.20.3.tgz`: SheetJS Community Edition, downloaded from
https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz (the npm `xlsx` package is
stuck at 0.18.5 with known vulnerabilities; SheetJS publishes only on its CDN).
Used by the shop import to read .xlsx, .xls and .ods files in the browser.

To upgrade: download the new tarball from cdn.sheetjs.com into this folder and
update `apps/app/package.json`.
