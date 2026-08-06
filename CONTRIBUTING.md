# Contributing to StockTrax

Thanks for your interest in improving StockTrax.

## License of contributions

StockTrax is licensed under the **GNU AGPL v3.0**. By contributing, you agree
that your contribution is provided under that same license.

## Developer Certificate of Origin (DCO)

To keep the project's licensing clean — and to preserve the maintainer's ability
to offer StockTrax under alternative license terms in the future — every commit
must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/).

The DCO is a simple statement that you wrote the contribution or otherwise have
the right to submit it under the project's license. You sign off by adding a line
to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

Git can add this automatically with the `-s` flag:

```bash
git commit -s -m "Add CSV export to the activity log"
```

## How to contribute

1. Fork the repository and create a branch for your change.
2. Make your change. Keep the style simple and dependency-light — that's the
   whole point of the project.
3. Sign off your commits (`git commit -s`).
4. Open a pull request describing what you changed and why.

## Good first areas

- Product photo upload for items without a database image
- Per-item history view and CSV export
- Locations (warehouse shelf / truck) per stock item
- Additional barcode-lookup providers in `src/barcode.js`

## Questions

Open an issue — happy to help.
