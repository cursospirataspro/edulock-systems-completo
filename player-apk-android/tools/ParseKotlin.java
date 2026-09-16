import java.nio.file.*;
import java.util.*;
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment;
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles;
import org.jetbrains.kotlin.config.CompilerConfiguration;
import org.jetbrains.kotlin.psi.KtPsiFactory;
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer;
import org.jetbrains.kotlin.com.intellij.psi.PsiErrorElement;
import org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil;

/** Syntax-only fallback for environments where Gradle cannot create its local daemon.
 * Does not replace Android compilation, resources, or device tests. */
class ParseKotlin {
    public static void main(String[] args) throws Exception {
        var disposable = Disposer.newDisposable();
        try {
            var env = KotlinCoreEnvironment.createForProduction(disposable, new CompilerConfiguration(), EnvironmentConfigFiles.JVM_CONFIG_FILES);
            var factory = new KtPsiFactory(env.getProject(), false);
            int count = 0, errors = 0;
            try (var paths = Files.walk(Path.of(args[0]))) {
                for (var path : paths.filter(p -> p.toString().endsWith(".kt")).toList()) {
                    var source = Files.readString(path).replace("\r\n", "\n").replace("\r", "\n");
                    var file = factory.createFile(path.getFileName().toString(), source);
                    for (var error : PsiTreeUtil.findChildrenOfType(file, PsiErrorElement.class)) {
                        if (errors < 30) System.out.println(path.getFileName() + ": offset " + error.getTextOffset() + ": " + error.getErrorDescription());
                        errors++;
                    }
                    count++;
                }
            }
            System.out.println("Kotlin syntax: " + count + " files, " + errors + " errors (not an APK build).");
            if (errors != 0) System.exit(1);
        } finally { Disposer.dispose(disposable); }
    }
}
