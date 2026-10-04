package com.dshdesktop.android

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Node 引擎状态（单例桥）：NodeService 生产，MainActivity 消费。
 */
object NodeState {
    enum class Phase { IDLE, PREPARING, STARTING, READY, FAILED }

    data class State(
        val phase: Phase = Phase.IDLE,
        val message: String = "",
        val url: String? = null,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    fun update(phase: Phase, message: String = "", url: String? = null, error: String? = null) {
        _state.value = State(phase, message, url, error)
    }

    fun patch(message: String) {
        _state.value = _state.value.copy(message = message)
    }
}
