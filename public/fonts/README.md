# Appearance fonts

Most families use Latin and extended Latin WOFF2 variable subsets from the
Google Fonts CSS API, plus Vietnamese where upstream provides it, weights 400 to 700. Lora and Quicksand use
complete upstream fonts, as described below.
The browser downloads a family on selection or a name preview on hover/focus.
Additional language subsets load only when their characters are used.
Scripts a family does not cover fall back to system fonts. All families use the SIL Open Font License.

- DM Sans: https://github.com/google/fonts/tree/main/ofl/dmsans (license: dm-sans-OFL.txt)
- Space Grotesk: https://github.com/google/fonts/tree/main/ofl/spacegrotesk (license: space-grotesk-OFL.txt)
- Outfit: https://github.com/google/fonts/tree/main/ofl/outfit (license: outfit-OFL.txt)
- Nunito: https://github.com/google/fonts/tree/main/ofl/nunito (license: nunito-OFL.txt)
- Quicksand: https://github.com/google/fonts/tree/main/ofl/quicksand (license: quicksand-OFL.txt)
- Work Sans: https://github.com/google/fonts/tree/main/ofl/worksans (license: work-sans-OFL.txt)
- Sora: https://github.com/google/fonts/tree/main/ofl/sora (license: sora-OFL.txt)
- Lora: https://github.com/google/fonts/tree/main/ofl/lora (license: lora-OFL.txt)
- Literata: https://github.com/google/fonts/tree/main/ofl/literata (license: literata-OFL.txt)
- Newsreader: https://github.com/google/fonts/tree/main/ofl/newsreader (license: newsreader-OFL.txt)
- Fraunces: https://github.com/google/fonts/tree/main/ofl/fraunces (license: fraunces-OFL.txt)
- Roboto Mono: https://github.com/google/fonts/tree/main/ofl/robotomono (license: roboto-mono-OFL.txt)

Lora and Quicksand declare Reserved Font Names. Their files here are the complete
upstream variable TTFs with WOFF2 compression only, using fontTools. No glyph
subsetting, instancing or renaming is performed; authorship and license metadata
are preserved. This follows the WOFF compression allowance in
[OFL FAQ, section 2.2](https://openfontlicense.org/ofl-faq/).
Other families have no Reserved Font Name declaration and use Google Fonts subsets.

Keeping the complete font deliberately adds a modest download for these two
families, while retaining the reserved name and full language coverage. Each
file still loads only when that face is selected or previewed.

| Face | Latin subset comparison (not included) | Complete WOFF2 |
| --- | ---: | ---: |
| Lora normal | 37,788 bytes | 85,096 bytes |
| Lora italic | 40,772 bytes | 91,636 bytes |
| Quicksand normal | 28,244 bytes | 52,816 bytes |
