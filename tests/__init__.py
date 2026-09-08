"""Project-local test package.

Keeping an explicit package marker prevents an unrelated site-package named
``tests`` from shadowing ``tests.support`` during a plain ``pytest`` run.
"""
