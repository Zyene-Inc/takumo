# vendor

`xlsx/`: SheetJS Community Edition 0.20.3, unpacked from
https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz (the npm `xlsx` package is
stuck at 0.18.5 with known vulnerabilities; SheetJS publishes only on its CDN).
Used by the shop import to read .xlsx, .xls and .ods files in the browser.

It's kept unpacked because pnpm records a folder dependency by its path; a
vendored .tgz gets recorded by checksum only and clean installs then look for
it on npm.

To upgrade: download the new tarball from cdn.sheetjs.com, check its sha512,
and unpack it over `xlsx/` (`tar -xzf <file> -C vendor/xlsx --strip-components=1`).
