from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    frontend_origins: str = "http://127.0.0.1:5173,http://localhost:5173"
    ytdlp_player_client: str = "mweb"
    ytdlp_player_clients: str = "web,mweb,ios,android"
    ytdlp_pot_provider: str = "bgutil"
    ytdlp_bgutil_base_url: str = "http://127.0.0.1:4416"
    ytdlp_socket_timeout: int = 20
    rate_limit_window_seconds: int = 60
    rate_limit_max_requests: int = 30

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @property
    def origins(self) -> list[str]:
        return [origin.strip() for origin in self.frontend_origins.split(",") if origin.strip()]

    @property
    def player_clients(self) -> list[str]:
        raw_clients = self.ytdlp_player_clients or self.ytdlp_player_client
        return [client.strip() for client in raw_clients.split(",") if client.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
