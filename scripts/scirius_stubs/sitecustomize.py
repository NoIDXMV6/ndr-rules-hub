# Заглушки модулей, требующих системных C-библиотек (ldap/saml),
# для тестового стенда Scirius. В тесте импорта правил не используются.
import sys
import types


def _mod(name):
    m = types.ModuleType(name)
    sys.modules[name] = m
    return m


from django.dispatch import Signal

ldap_backend = _mod("django_auth_ldap.backend")
ldap_backend.LDAPBackend = type("LDAPBackend", (), {})
ldap_backend._LDAPUser = type("_LDAPUser", (), {})
ldap_backend.populate_user = Signal()  # provide_sender
ldap_backend.ldap_error = Signal()
pkg = sys.modules.setdefault("django_auth_ldap", types.ModuleType("django_auth_ldap"))
pkg.backend = ldap_backend

saml = _mod("djangosaml2")
saml.backends = _mod("djangosaml2.backends")
saml.backends.Saml2Backend = type("Saml2Backend", (), {})
saml.cache = _mod("djangosaml2.cache")
saml.cache.SAMLSessionCache = object
saml.overrides = _mod("djangosaml2.overrides")
saml.overrides.Saml2ClientSessionStore = object
