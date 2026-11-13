from pathlib import Path


def read_style_source(path: Path) -> str:
    """Include Mihomo's separately loaded overrides in visual contract checks."""
    text = path.read_text(encoding='utf-8')
    module = path.parent / 'mihomo.module.css'
    if path.name in {'styles.css', 'panel-operator.css'} and module.is_file():
        # Keep checks of the flat operator layer separate from legacy base rules.
        base, operator = module.read_text(encoding='utf-8').split(
            '/* From panel-operator.css; original cascade order retained. */', 1,
        )
        text += '\n' + (base if path.name == 'styles.css' else operator)
    return text
