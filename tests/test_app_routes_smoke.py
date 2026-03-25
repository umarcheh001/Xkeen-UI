from __future__ import annotations

import pytest


@pytest.mark.linux_only
def test_auth_status_is_available_before_setup(app_client):
    response = app_client.get("/auth/status")
    assert response.status_code == 200
    payload = response.get_json()
    assert isinstance(payload, dict)
    assert "configured" in payload


@pytest.mark.linux_only
def test_root_redirects_to_setup_when_auth_is_not_configured(app_client):
    response = app_client.get("/", follow_redirects=False)
    assert response.status_code in (301, 302, 303, 307, 308)
    assert "/setup" in response.headers["Location"]


@pytest.mark.linux_only
def test_login_redirects_to_setup_when_auth_is_not_configured(app_client):
    response = app_client.get("/login", follow_redirects=False)
    assert response.status_code in (301, 302, 303, 307, 308)
    assert "/setup" in response.headers["Location"]
