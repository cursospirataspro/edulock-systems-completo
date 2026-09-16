# ProGuard rules for EDULOCK Player
# Proteger clases sensibles y mantener funcionalidad

# Mantener clases de API
-keep class com.edulock.player.api.** { *; }
-keep class com.edulock.player.api.**$* { *; }

# Mantener clases de seguridad
-keep class com.edulock.player.security.** { *; }
-keep class com.edulock.player.security.**$* { *; }

# Mantener clases de utilidades
-keep class com.edulock.player.utils.** { *; }
-keep class com.edulock.player.utils.**$* { *; }

# Mantener modelos de datos
-keepclassmembers class com.edulock.player.api.** {
    public static <fields>;
    public static <methods>;
}

# Mantener clases de Android
-keep class androidx.** { *; }
-keep class com.google.android.exoplayer2.** { *; }
-keep class com.google.android.material.** { *; }

# Mantener clases de Retrofit
-keepattributes Signature
-keepattributes *Annotation*
-keep class retrofit2.** { *; }
-keep class okhttp3.** { *; }
-keep class com.google.gson.** { *; }

# Mantener métodos de callback
-keepclasseswithmembernames class * {
    native <methods>;
}

# Optimizaciones
-optimizationpasses 5
-repackageclasses ''
-allowaccessmodification
-optimizations !code/simplification/arithmetic,!field/*,!class/merging/*

# Suprimir advertencias
-dontwarn android.**
-dontwarn androidx.**
-dontwarn okhttp3.**
-dontwarn retrofit2.**
-dontwarn com.google.**
-dontwarn org.bouncycastle.**

# Logging
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
}
