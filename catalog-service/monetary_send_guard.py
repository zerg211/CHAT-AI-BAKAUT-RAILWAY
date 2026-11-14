"""Fail closed for Python paid sends when monetary guard is enabled."""

import os


def refuse_paid_send_when_guarded():
    value = os.environ.get('OPENAI_MONETARY_GUARD_ENABLED', '').strip().lower()
    if value in ('1', 'true', 'yes', 'on'):
        raise RuntimeError('OPENAI_MONETARY_GUARD_ENABLED blocks paid Python requests')
    if value not in ('', '0', 'false', 'no', 'off'):
        raise ValueError('Invalid OPENAI_MONETARY_GUARD_ENABLED')
