from pathlib import Path

from fpgaweb.jsonc import load_jsonc


def test_strips_line_comments_but_not_urls_in_strings(tmp_path: Path):
    p = tmp_path / "a.jsonc"
    p.write_text('// header\n{\n  "url": "https://x.org/a", // trailing\n  "n": 1\n}\n')
    assert load_jsonc(p) == {"url": "https://x.org/a", "n": 1}


def test_escaped_quote_inside_string(tmp_path: Path):
    p = tmp_path / "b.jsonc"
    p.write_text('{"s": "say \\"hi\\" // not a comment"}')
    assert load_jsonc(p) == {"s": 'say "hi" // not a comment'}
