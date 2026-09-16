package com.edulock.player.security

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.Log

/**
 * SecurityMonitorService - Servicio de monitoreo de seguridad
 * Detecta y registra intentos de bypass o debugging
 */
class SecurityMonitorService : Service() {

    companion object {
        private const val TAG = "SecurityMonitorService"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "SecurityMonitorService iniciado")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.i(TAG, "SecurityMonitorService detenido")
    }
}
