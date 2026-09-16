package com.edulock.player.api

import android.content.Context
import android.util.Log
import com.google.gson.GsonBuilder
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * ApiClient.kt — Configuración centralizada de Retrofit
 *
 * Responsabilidades:
 * 1. Crear singleton de Retrofit
 * 2. Configurar OkHttp con timeouts
 * 3. Configurar logging (debug mode)
 * 4. Proporcionar instancia de EdulockApiService
 *
 * Uso:
 *   val apiService = ApiClient.getService()
 *   val response = apiService.login(request)
 */
object ApiClient {

    private const val TAG = "ApiClient"

    // Configuración
    private var baseUrl = "http://localhost:3000/"
    private var service: EdulockApiService? = null
    private var retrofit: Retrofit? = null

    /**
     * Establecer URL base del API
     * @param url URL completa (ej: "https://mi-dominio.com/" o "http://localhost:3000/")
     */
    fun setBaseUrl(url: String) {
        if (url != baseUrl) {
            baseUrl = if (url.endsWith("/")) url else "$url/"
            service = null  // Resetear para recrear con nueva URL
            retrofit = null
            Log.i(TAG, "✅ Base URL actualizada: $baseUrl")
        }
    }

    /**
     * Obtener la URL base actual
     */
    fun getBaseUrl(): String = baseUrl

    /**
     * Obtener instancia del servicio API
     */
    fun getService(): EdulockApiService {
        if (service == null) {
            service = getRetrofit().create(EdulockApiService::class.java)
            Log.d(TAG, "✅ EdulockApiService creado")
        }
        return service!!
    }

    /**
     * Obtener instancia de Retrofit (recrear si fue modificada la URL)
     */
    private fun getRetrofit(): Retrofit {
        if (retrofit == null) {
            retrofit = Retrofit.Builder()
                .baseUrl(baseUrl)
                .client(getHttpClient())
                .addConverterFactory(GsonConverterFactory.create(GsonBuilder().setPrettyPrinting().create()))
                .build()
            Log.d(TAG, "✅ Retrofit configurado con URL: $baseUrl")
        }
        return retrofit!!
    }

    /**
     * Configurar cliente HTTP con timeouts y logging
     */
    private fun getHttpClient(): OkHttpClient {
        val builder = OkHttpClient.Builder()

        // Timeouts
        builder.connectTimeout(15, TimeUnit.SECONDS)
        builder.readTimeout(30, TimeUnit.SECONDS)
        builder.writeTimeout(30, TimeUnit.SECONDS)

        // Logging (solo en debug)
        val loggingInterceptor = HttpLoggingInterceptor { message ->
            Log.d(TAG, "📡 HTTP: $message")
        }
        loggingInterceptor.level = HttpLoggingInterceptor.Level.NONE
        builder.addInterceptor(loggingInterceptor)

        // Interceptor para agregar headers
        builder.addInterceptor { chain ->
            val request = chain.request()
            Log.d(TAG, "→ ${request.method} ${request.url}")
            val response = chain.proceed(request)
            Log.d(TAG, "← ${response.code}")
            response
        }

        return builder.build()
    }
}
