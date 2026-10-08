# Known limitations

- Model output is probabilistic. Review important findings and actions against the source.
- Agent tool use and final reporting can be inconsistent. In the final packaged smoke check, one run did not call a tool. A fresh run did call `read_file`, but the model then returned text that did not match the file. The UI marked that run as passed.
- Qwen2.5 Coder 7B is the certified reference model. Other models have not passed the V0 gate.
- Complex grounded document tasks exceed the normal 120-second target. The successful Flow A recording took 203 seconds; certification runs took 229.6 to 257.5 seconds.
- Some code-repair paraphrases still fail behavioral validation.
- Some document-review tasks can omit requested items.
- OCR and image interpretation depend on the configured visual model and source quality.
- The V0-critical suite passes. The wider legacy test suite still has pre-existing failures; see the shipping status report.
- The production dependency audit has two moderate findings in ExcelJS's nested UUID dependency. The advisory is for UUID v3/v5/v6 when callers supply a buffer. The app's ExcelJS code path uses v4. No high or critical production dependency findings remain.
- The macOS V0 bundle is unsigned and uses Electron's default icon. It is a local build. Public macOS distribution needs a signed and notarized package.
