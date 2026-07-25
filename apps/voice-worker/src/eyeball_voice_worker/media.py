"""Lazy Pipecat media assembly for Twilio and LiveKit transports."""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, cast
from urllib.parse import urlencode

import httpx
from pydantic import JsonValue

from .config import WorkerConfig
from .contracts import LiveKitTransport, StartSessionRequest, TwilioTransport
from .executor import ExecutorResult

ToolExecutor = Callable[
    [str, str, str, dict[str, JsonValue]], Awaitable[ExecutorResult]
]
TranscriptRecorder = Callable[[str, str, str], str]



def _inline_local_refs(schema: dict[str, Any]) -> dict[str, Any]:
    """Resolve local #/$defs references so LLM tool schemas stay self-contained
    after the $defs root is stripped by downstream function-schema builders."""
    defs = schema.get("$defs")
    if not isinstance(defs, dict):
        return schema

    def resolve(node: Any, seen: tuple[str, ...]) -> Any:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                name = ref[len("#/$defs/") :]
                target = defs.get(name)
                if isinstance(target, dict) and name not in seen:
                    extras = {k: v for k, v in node.items() if k != "$ref"}
                    resolved = resolve(target, seen + (name,))
                    if isinstance(resolved, dict) and extras:
                        return {**resolved, **extras}
                    return resolved
                return node
            return {key: resolve(value, seen) for key, value in node.items()}
        if isinstance(node, list):
            return [resolve(item, seen) for item in node]
        return node

    return {
        key: resolve(value, ())
        for key, value in schema.items()
        if key != "$defs"
    }

class MediaConfigurationError(RuntimeError):
    pass


def pipecat_installed() -> bool:
    return importlib.util.find_spec("pipecat") is not None


def live_credentials_ready(config: WorkerConfig) -> bool:
    return all(
        (
            config.anthropic_api_key,
            config.deepgram_api_key,
            config.elevenlabs_api_key,
        )
    )


def twilio_media_token(config: WorkerConfig, session_id: str) -> str:
    """Bind a public Twilio media socket to its control-plane session."""
    control_token = config.control_token
    if control_token is None or control_token.strip() == "":
        raise MediaConfigurationError(
            "EYEBALL_VOICE_WORKER_TOKEN is required for Twilio media sockets."
        )
    return hmac.new(
        control_token.encode(),
        f"twilio-media\0{session_id}".encode(),
        hashlib.sha256,
    ).hexdigest()


class PipecatPipelineFactory:
    """Builds one isolated pipeline from an immutable session snapshot."""

    def __init__(
        self,
        *,
        config: WorkerConfig,
        execute_tool: ToolExecutor,
        record_transcript: TranscriptRecorder,
    ) -> None:
        self._config = config
        self._execute_tool = execute_tool
        self._record_transcript = record_transcript

    async def chat(
        self,
        session_id: str,
        request: StartSessionRequest,
        turn_id: str,
        history: list[Any],
    ) -> str:
        """Run one text turn through Anthropic and the durable tool bridge."""
        if self._config.anthropic_api_key is None:
            raise MediaConfigurationError(
                "ANTHROPIC_API_KEY is required for chat sessions."
            )
        try:
            from anthropic import AsyncAnthropic
        except ImportError as error:
            raise MediaConfigurationError(
                "Install `eyeball-voice-worker[media]` for chat sessions."
            ) from error

        tools: list[dict[str, Any]] = []
        tool_names: dict[str, str] = {}
        for tool in request.agent.allowed_tools:
            encoded_name = tool.name.replace(".", "__")
            tool_names[encoded_name] = tool.name
            tools.append(
                {
                    "name": encoded_name,
                    "description": tool.description,
                    "input_schema": _inline_local_refs(tool.input_schema),
                }
            )
        messages = _anthropic_messages(history)
        text_parts: list[str] = []
        async with AsyncAnthropic(api_key=self._config.anthropic_api_key) as client:
            for model_round in range(8):
                options: dict[str, Any] = {
                    "model": request.agent.llm.model,
                    "max_tokens": request.agent.llm.max_output_tokens or 1_024,
                    "system": request.agent.system_prompt,
                    "messages": messages,
                }
                if request.agent.llm.temperature is not None:
                    options["temperature"] = request.agent.llm.temperature
                if tools:
                    options["tools"] = tools
                response = await client.messages.create(**options)
                blocks = list(response.content)
                text_parts.extend(
                    block.text
                    for block in blocks
                    if getattr(block, "type", None) == "text"
                    and isinstance(getattr(block, "text", None), str)
                    and block.text
                )
                tool_blocks = [
                    block
                    for block in blocks
                    if getattr(block, "type", None) == "tool_use"
                ]
                if not tool_blocks:
                    assistant = "".join(text_parts).strip()
                    if assistant == "":
                        raise MediaConfigurationError(
                            "Anthropic returned no assistant text."
                        )
                    return assistant
                messages.append(
                    {
                        "role": "assistant",
                        "content": [
                            block.model_dump(mode="json", exclude_none=True)
                            for block in blocks
                        ],
                    }
                )
                tool_results: list[dict[str, Any]] = []
                for ordinal, block in enumerate(tool_blocks):
                    encoded_name = getattr(block, "name", "")
                    canonical_name = tool_names.get(encoded_name)
                    block_input = getattr(block, "input", {})
                    if canonical_name is None or not isinstance(block_input, Mapping):
                        raise MediaConfigurationError(
                            "Anthropic returned an invalid tool call."
                        )
                    result = await self._execute_tool(
                        session_id,
                        f"{turn_id}_tool_{model_round}_{ordinal}",
                        canonical_name,
                        dict(block_input),
                    )
                    is_error = result.error is not None
                    payload = result.error if is_error else result.output
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": json.dumps(payload, separators=(",", ":")),
                            "is_error": is_error,
                        }
                    )
                messages.append({"role": "user", "content": tool_results})
        raise MediaConfigurationError(
            "Anthropic exceeded the worker's eight-round tool limit."
        )

    async def livekit(
        self, session_id: str, request: StartSessionRequest
    ) -> Callable[[], Awaitable[None]]:
        transport_config = request.transport
        if not isinstance(transport_config, LiveKitTransport):
            raise MediaConfigurationError("Expected a LiveKit transport snapshot.")
        if not all(
            (
                self._config.livekit_url,
                self._config.livekit_api_key,
                self._config.livekit_api_secret,
            )
        ):
            raise MediaConfigurationError(
                "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required."
            )
        try:
            from pipecat.runner.livekit import generate_token_with_agent
            from pipecat.transports.livekit.transport import (
                LiveKitParams,
            )
            from pipecat.transports.livekit.transport import (
                LiveKitTransport as PipecatLiveKitTransport,
            )
        except ImportError as error:
            raise MediaConfigurationError(
                "Install the voice worker's media extra for LiveKit support."
            ) from error
        token = generate_token_with_agent(
            transport_config.room_name,
            transport_config.participant_identity or "eyeball-voice-worker",
            cast(str, self._config.livekit_api_key),
            cast(str, self._config.livekit_api_secret),
        )
        transport = PipecatLiveKitTransport(
            url=cast(str, self._config.livekit_url),
            token=token,
            room_name=transport_config.room_name,
            params=LiveKitParams(audio_in_enabled=True, audio_out_enabled=True),
        )
        return self._pipeline(session_id, request, transport)

    async def twilio(
        self, session_id: str, request: StartSessionRequest, websocket: Any
    ) -> Callable[[], Awaitable[None]]:
        if not isinstance(request.transport, TwilioTransport):
            raise MediaConfigurationError("Expected a Twilio transport snapshot.")
        try:
            from pipecat.runner.utils import parse_telephony_websocket
            from pipecat.serializers.twilio import TwilioFrameSerializer
            from pipecat.transports.websocket.fastapi import (
                FastAPIWebsocketParams,
                FastAPIWebsocketTransport,
            )
        except ImportError as error:
            raise MediaConfigurationError(
                "Install the voice worker's media extra for Twilio support."
            ) from error
        transport_type, call_data = await parse_telephony_websocket(websocket)
        if transport_type != "twilio":
            raise MediaConfigurationError("The media socket was not a Twilio stream.")
        serializer = TwilioFrameSerializer(
            stream_sid=call_data["stream_id"],
            call_sid=call_data["call_id"],
            account_sid=self._config.twilio_account_sid,
            auth_token=self._config.twilio_auth_token,
        )
        transport = FastAPIWebsocketTransport(
            websocket=call_data.get("websocket", websocket),
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                add_wav_header=False,
                serializer=serializer,
            ),
        )
        return self._pipeline(
            session_id,
            request,
            transport,
            audio_sample_rate=8_000,
        )

    def _pipeline(
        self,
        session_id: str,
        request: StartSessionRequest,
        transport: Any,
        *,
        audio_sample_rate: int | None = None,
    ) -> Callable[[], Awaitable[None]]:
        self._require_ai_credentials()
        try:
            from pipecat.adapters.schemas.function_schema import FunctionSchema
            from pipecat.adapters.schemas.tools_schema import ToolsSchema
            from pipecat.audio.vad.silero import SileroVADAnalyzer
            from pipecat.audio.vad.vad_analyzer import VADParams
            from pipecat.pipeline.pipeline import Pipeline
            from pipecat.pipeline.runner import PipelineRunner
            from pipecat.pipeline.task import PipelineParams, PipelineTask
            from pipecat.processors.aggregators.llm_context import LLMContext
            from pipecat.processors.aggregators.llm_response_universal import (
                LLMContextAggregatorPair,
                LLMUserAggregatorParams,
            )
            from pipecat.services.anthropic import AnthropicLLMService
            from pipecat.services.deepgram.stt import DeepgramSTTService
            from pipecat.services.elevenlabs import ElevenLabsTTSService
            from pipecat.services.llm_service import FunctionCallParams
            from pipecat.turns.user_mute import (
                AlwaysUserMuteStrategy,
                FunctionCallUserMuteStrategy,
            )
        except ImportError as error:
            raise MediaConfigurationError(
                "Install `eyeball-voice-worker[media]` to assemble Pipecat."
            ) from error

        voice = request.agent.voice
        stt_config = _object(voice.get("stt"), "agent.voice.stt")
        tts_config = _object(voice.get("tts"), "agent.voice.tts")
        llm_settings: dict[str, Any] = {
            "model": request.agent.llm.model,
            "system_instruction": request.agent.system_prompt,
        }
        if request.agent.llm.temperature is not None:
            llm_settings["temperature"] = request.agent.llm.temperature
        if request.agent.llm.max_output_tokens is not None:
            llm_settings["max_tokens"] = request.agent.llm.max_output_tokens
        llm = AnthropicLLMService(
            api_key=cast(str, self._config.anthropic_api_key),
            settings=AnthropicLLMService.Settings(**llm_settings),
        )
        stt = DeepgramSTTService(
            api_key=cast(str, self._config.deepgram_api_key),
            settings=DeepgramSTTService.Settings(
                model=stt_config.get("model", "nova-3"),
                language=stt_config.get("language", "en"),
                endpointing=500,
                smart_format=stt_config.get("smartFormat", True),
                interim_results=stt_config.get("interimResults", True),
            ),
        )
        tts_settings: dict[str, Any] = {
            "voice": tts_config["voiceId"],
            "model": tts_config.get("modelId", "eleven_turbo_v2_5"),
        }
        if tts_config.get("stability") is not None:
            tts_settings["stability"] = tts_config["stability"]
        if tts_config.get("similarityBoost") is not None:
            tts_settings["similarity_boost"] = tts_config["similarityBoost"]
        tts = ElevenLabsTTSService(
            api_key=cast(str, self._config.elevenlabs_api_key),
            settings=ElevenLabsTTSService.Settings(**tts_settings),
        )

        schemas = []
        for tool in request.agent.allowed_tools:
            encoded_name = tool.name.replace(".", "__")
            inlined_schema = _inline_local_refs(tool.input_schema)
            properties_value = inlined_schema.get("properties", {})
            properties = properties_value if isinstance(properties_value, dict) else {}
            required_value = inlined_schema.get("required", [])
            required = (
                required_value
                if isinstance(required_value, list)
                and all(isinstance(item, str) for item in required_value)
                else []
            )
            schemas.append(
                FunctionSchema(
                    name=encoded_name,
                    description=tool.description,
                    properties=properties,
                    required=required,
                )
            )

            async def handler(
                params: FunctionCallParams,
                *,
                canonical_name: str = tool.name,
            ) -> None:
                turn_id = f"turn_{request.agent.id}_{params.tool_call_id}"
                arguments = (
                    params.arguments if isinstance(params.arguments, dict) else {}
                )
                result = await self._execute_tool(
                    session_id,
                    turn_id,
                    canonical_name,
                    arguments,
                )
                await params.result_callback(
                    result.error if result.error is not None else result.output
                )

            llm.register_function(
                encoded_name,
                handler,
                cancel_on_interruption=True,
            )

        turn_stop_seconds = self._config.voice_turn_stop_seconds
        audio_idle_timeout = max(turn_stop_seconds + 0.25, 1.6)

        context = LLMContext(tools=ToolsSchema(standard_tools=schemas))
        mute_strategies: list[Any] = [FunctionCallUserMuteStrategy()]
        if not request.agent.barge_in.enabled:
            mute_strategies.append(AlwaysUserMuteStrategy())
        user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                audio_idle_timeout=audio_idle_timeout,
                vad_analyzer=SileroVADAnalyzer(
                    params=VADParams(stop_secs=turn_stop_seconds),
                ),
                user_mute_strategies=mute_strategies,
            ),
        )

        @user_aggregator.event_handler(  # type: ignore[untyped-decorator]
            "on_user_turn_stopped"
        )
        async def on_user_turn_stopped(
            _aggregator: Any,
            _strategy: Any,
            message: Any,
        ) -> None:
            text = _turn_text(message)
            if text:
                self._record_transcript(session_id, "human", text)

        @assistant_aggregator.event_handler(  # type: ignore[untyped-decorator]
            "on_assistant_turn_stopped"
        )
        async def on_assistant_turn_stopped(
            _aggregator: Any,
            message: Any,
        ) -> None:
            text = _turn_text(message)
            if text:
                self._record_transcript(session_id, "agent", text)

        pipeline = Pipeline(
            [
                transport.input(),
                stt,
                user_aggregator,
                llm,
                tts,
                transport.output(),
                assistant_aggregator,
            ]
        )
        pipeline_params: dict[str, Any] = {
            "enable_metrics": True,
            "enable_usage_metrics": True,
        }
        if audio_sample_rate is not None:
            pipeline_params.update(
                audio_in_sample_rate=audio_sample_rate,
                audio_out_sample_rate=audio_sample_rate,
            )
        task = PipelineTask(
            pipeline,
            params=PipelineParams(**pipeline_params),
        )

        async def run() -> None:
            await PipelineRunner(handle_sigint=False).run(task)

        return run

    def _require_ai_credentials(self) -> None:
        missing = [
            name
            for name, value in (
                ("ANTHROPIC_API_KEY", self._config.anthropic_api_key),
                ("DEEPGRAM_API_KEY", self._config.deepgram_api_key),
                ("ELEVENLABS_API_KEY", self._config.elevenlabs_api_key),
            )
            if value is None or value == ""
        ]
        if missing:
            raise MediaConfigurationError(f"Live media requires {', '.join(missing)}.")


class TwilioDialer:
    def __init__(self, config: WorkerConfig, client: httpx.AsyncClient) -> None:
        self._config = config
        self._client = client

    async def dial(self, session_id: str, transport: TwilioTransport) -> str:
        required = {
            "TWILIO_ACCOUNT_SID": self._config.twilio_account_sid,
            "TWILIO_AUTH_TOKEN": self._config.twilio_auth_token,
            "EYEBALL_VOICE_PUBLIC_URL": self._config.public_url,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise MediaConfigurationError(
                f"Twilio dialing requires {', '.join(missing)}."
            )
        base = cast(str, self._config.public_url).rstrip("/")
        websocket_url = base.replace("https://", "wss://").replace("http://", "ws://")
        query = urlencode({"token": twilio_media_token(self._config, session_id)})
        twiml = (
            '<Response><Connect><Stream url="'
            f"{websocket_url}/v1/media/twilio/{session_id}?{query}"
            '" /></Connect></Response>'
        )
        from_number = transport.from_ or self._config.twilio_from_number
        if not from_number:
            raise MediaConfigurationError(
                "A Twilio `from` number or TWILIO_FROM_NUMBER is required."
            )
        account_sid = cast(str, self._config.twilio_account_sid)
        # Trial accounts reject inline Twiml on Calls.json; serve the same
        # document through the echo twimlet Url instead.
        echo_url = "https://twimlets.com/echo?" + urlencode({"Twiml": twiml})
        response = await self._client.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Calls.json",
            auth=(account_sid, cast(str, self._config.twilio_auth_token)),
            data={"To": transport.to, "From": from_number, "Url": echo_url},
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("sid"), str):
            raise MediaConfigurationError("Twilio returned an invalid call response.")
        return cast(str, payload["sid"])


def _object(value: JsonValue | None, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise MediaConfigurationError(f"{field} must be an object.")
    return value


def _turn_text(turn: Any) -> str:
    content = getattr(turn, "content", None)
    if isinstance(content, str):
        return content
    text = getattr(turn, "text", None)
    if isinstance(text, str):
        return text
    messages = getattr(turn, "messages", None)
    if isinstance(messages, list):
        return " ".join(
            str(message.get("content", ""))
            for message in messages
            if isinstance(message, dict)
        ).strip()
    return str(turn)


def _anthropic_messages(events: list[Any]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for event in events:
        data = getattr(event, "data", None)
        if not isinstance(data, dict) or data.get("type") != "turn.transcript":
            continue
        speaker = data.get("speaker")
        text = data.get("text")
        if speaker not in {"human", "agent"} or not isinstance(text, str):
            continue
        role = "user" if speaker == "human" else "assistant"
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"] = f"{messages[-1]['content']}\n{text}"
        else:
            messages.append({"role": role, "content": text})
    if not messages or messages[-1]["role"] != "user":
        raise MediaConfigurationError(
            "A chat turn requires a durable final user transcript."
        )
    return messages
