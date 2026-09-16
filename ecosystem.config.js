'use strict';
/**
 * ecosystem.config.js — Configuración PM2
 *
 * PM2 es el gestor de procesos que mantiene el servidor corriendo 24/7:
 *   - Reinicia automáticamente si el servidor crashea
 *   - Arranca solo cuando se reinicia el VPS
 *   - Modo cluster: usa todos los núcleos del CPU (más velocidad)
 *   - Rotación de logs automática
 *
 * Comandos útiles después de desplegar:
 *   pm2 start ecosystem.config.js    → iniciar
 *   pm2 restart reproductor          → reiniciar
 *   pm2 stop reproductor             → detener
 *   pm2 logs reproductor             → ver logs en tiempo real
 *   pm2 monit                        → monitor de CPU/RAM en tiempo real
 *   pm2 save                         → guardar estado actual
 *   pm2 startup                      → configurar arranque automático al reiniciar
 */

module.exports = {
    apps: [{
        name: 'reproductor',
        script: 'server.js',

        // INSTANCIA ÚNICA (fork): el servidor mantiene estado en memoria por
        // proceso — claves de un solo uso (_keyTokens), rate-limit y caché de
        // revocación. En cluster, un worker no ve el estado de otro → errores
        // intermitentes "clave expirada" y límites multiplicados (ver PDF, Mejora 2).
        // Para escalar a varios núcleos: mover ese estado a Redis y volver a 'max'.
        instances: 1,
        exec_mode: 'fork',

        // Reinicio automático
        watch: false,             // no recargar al cambiar archivos (solo en producción)
        autorestart: true,        // reiniciar si crashea
        max_restarts: 10,         // máximo 10 reinicios rápidos antes de parar
        restart_delay: 2000,      // esperar 2s entre reinicios

        // Límite de memoria: si supera 512MB, reinicia (previene memory leaks)
        max_memory_restart: '512M',

        // Variables de entorno para producción
        env_production: {
            NODE_ENV: 'production',
        },

        // Logs
        out_file: './logs/out.log',
        error_file: './logs/error.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        merge_logs: true,

        // Apagado elegante: espera a que terminen las peticiones en curso
        kill_timeout: 5000,
        listen_timeout: 3000,
    }],
};
