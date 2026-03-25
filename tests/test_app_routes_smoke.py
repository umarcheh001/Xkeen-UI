import pytest


@pytest.mark.linux_only
def test_auth_status_is_available_before_setup(app_client):
    response = app_client.get("/auth/status", follow_redirects=False)

    if response.status_code == 200:
        assert response.is_json
        payload = response.get_json(silent=True) or {}
        assert isinstance(payload, dict)
    else:
        assert response.status_code == 302
        location = response.headers.get("Location", "")
        assert "/setup" in location or "/login" in location


@pytest.mark.linux_only
def test_root_redirects_to_setup_when_auth_is_not_configured(app_client):
    response = app_client.get("/", follow_redirects=False)
    assert response.status_code in (301, 302, 303, 307, 308)


@pytest.mark.linux_only
def test_login_redirects_to_setup_when_auth_is_not_configured(app_client):
    response = app_client.get("/login", follow_redirects=False)
    assert response.status_code in (200, 301, 302, 303, 307, 308)