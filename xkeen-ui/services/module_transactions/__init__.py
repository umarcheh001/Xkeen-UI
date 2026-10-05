"""Install, repair and remove one official panel module with a rollback.

The package is used both by the panel and by the detached runner
``scripts/module_transaction.py``. The runner has to work when the panel
itself does not start, so nothing here imports Flask, the application
factory or the routes.
"""
